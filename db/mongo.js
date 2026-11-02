/* db/mongo.js
   MongoDB Atlas connection manager for Number Snake (number_snake_db).
   Falls back to a persistent local JSON database (data/db.json) when Atlas credentials are
   placeholders or the network is unavailable, so the app never crashes and scores persist.
   The local fallback implements the small subset of the MongoDB collection API that the
   app uses (findOne, find().sort().limit().toArray(), insertOne, updateOne, updateMany,
   countDocuments, createIndex) with the operators $set, $setOnInsert, $lt, $lte, $gt, $gte, $ne, $in. */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_DB_PATH = process.env.NS_LOCAL_DB_PATH || path.join(DATA_DIR, 'db.json');

let _client = null;
let _db = null;
let _isAtlas = false;

// ---------------------------------------------------------------------------
// Persistent local database fallback
// ---------------------------------------------------------------------------
function newId() {
  return crypto.randomBytes(12).toString('hex');
}

// Dates are stored as ISO strings in the JSON file, so comparisons use the same form.
function norm(v) {
  return v instanceof Date ? v.toISOString() : v;
}

class LocalStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.cache = null;
  }

  load() {
    if (this.cache) return this.cache;
    try {
      if (fs.existsSync(this.filePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8') || '{}');
      } else {
        this.cache = {};
      }
    } catch (err) {
      console.error('[local-db] Could not read ' + this.filePath + ' (' + err.message + '). Starting empty.');
      this.cache = {};
    }
    return this.cache;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);   // atomic replace: a crash never leaves a half-written file
    } catch (err) {
      console.error('[local-db] Failed to write:', err.message);
    }
  }
}

function opMatch(value, cond) {
  value = norm(value);
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const keys = Object.keys(cond);
    if (keys.some(k => k.startsWith('$'))) {
      for (const k of keys) {
        const c = norm(cond[k]);
        if (k === '$lt' && !(value < c)) return false;
        else if (k === '$lte' && !(value <= c)) return false;
        else if (k === '$gt' && !(value > c)) return false;
        else if (k === '$gte' && !(value >= c)) return false;
        else if (k === '$ne' && value === c) return false;
        else if (k === '$in' && !cond[k].map(norm).includes(value)) return false;
        else if (!['$lt', '$lte', '$gt', '$gte', '$ne', '$in'].includes(k)) {
          throw new Error('Unsupported operator in local db: ' + k);
        }
      }
      return true;
    }
  }
  return value === norm(cond);
}

function matches(item, query) {
  for (const k of Object.keys(query || {})) {
    if (!opMatch(item[k], query[k])) return false;
  }
  return true;
}

class LocalCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  _items() {
    const all = this.store.load();
    if (!all[this.name]) all[this.name] = [];
    return all[this.name];
  }

  async findOne(query = {}) {
    const hit = this._items().find(item => matches(item, query));
    return hit ? JSON.parse(JSON.stringify(hit)) : null;
  }

  find(query = {}) {
    let items = this._items().filter(item => matches(item, query)).map(i => JSON.parse(JSON.stringify(i)));
    const cursor = {
      sort(sortObj = {}) {
        const keys = Object.keys(sortObj);
        items.sort((a, b) => {
          for (const key of keys) {
            const dir = sortObj[key] >= 0 ? 1 : -1;
            const x = norm(a[key]);
            const y = norm(b[key]);
            if (x < y) return -1 * dir;
            if (x > y) return 1 * dir;
          }
          return 0;
        });
        return cursor;
      },
      limit(n) {
        if (typeof n === 'number' && n > 0) items = items.slice(0, n);
        return cursor;
      },
      async toArray() {
        return items;
      }
    };
    return cursor;
  }

  async insertOne(doc) {
    const items = this._items();
    const clone = JSON.parse(JSON.stringify(doc));
    const newDoc = Object.assign({ _id: newId() }, clone);
    // Same behaviour as the unique indexes created on Atlas
    for (const spec of (this.store.unique[this.name] || [])) {
      if (spec.every(f => newDoc[f] !== undefined) && items.some(it => spec.every(f => it[f] === newDoc[f]))) {
        const err = new Error('E11000 duplicate key error (' + this.name + ')');
        err.code = 11000;
        throw err;
      }
    }
    items.push(newDoc);
    this.store.save();
    return { insertedId: newDoc._id };
  }

  _apply(item, update) {
    if (update.$set) Object.assign(item, JSON.parse(JSON.stringify(update.$set)));
  }

  async updateOne(query, update, options = {}) {
    const items = this._items();
    const idx = items.findIndex(item => matches(item, query));
    if (idx >= 0) {
      this._apply(items[idx], update);
      this.store.save();
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (options.upsert) {
      const base = {};
      for (const k of Object.keys(query)) {
        const v = query[k];
        if (!(v && typeof v === 'object' && !(v instanceof Date))) base[k] = norm(v);   // equality fields only
      }
      const doc = Object.assign({ _id: newId() }, base,
        JSON.parse(JSON.stringify(update.$setOnInsert || {})),
        JSON.parse(JSON.stringify(update.$set || {})));
      items.push(doc);
      this.store.save();
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async updateMany(query, update) {
    const items = this._items();
    let n = 0;
    for (const item of items) {
      if (matches(item, query)) { this._apply(item, update); n++; }
    }
    if (n) this.store.save();
    return { matchedCount: n, modifiedCount: n };
  }

  async countDocuments(query = {}) {
    return this._items().filter(item => matches(item, query)).length;
  }

  async createIndex(spec, opts = {}) {
    if (opts && opts.unique) {
      const fields = Object.keys(spec);
      const list = this.store.unique[this.name] || (this.store.unique[this.name] = []);
      if (!list.some(f => f.join() === fields.join())) list.push(fields);
    }
    return true;
  }
}

class LocalDb {
  constructor(filePath) {
    this.store = new LocalStore(filePath);
    this.store.unique = {};
  }
  collection(name) {
    return new LocalCollection(this.store, name);
  }
}

let _localDbInstance = null;
function localDb() {
  if (!_localDbInstance) _localDbInstance = new LocalDb(LOCAL_DB_PATH);
  return _localDbInstance;
}

// Create an index set on whichever database is active (Atlas or the local file).
async function ensureIndexes(database) {
  await database.collection('players').createIndex({ playerId: 1 }, { unique: true, name: 'playerId_unique' });
  await database.collection('game_runs').createIndex({ playerId: 1, playedAt: -1 }, { name: 'playerId_playedAt' });
  await database.collection('certificates').createIndex({ playerId: 1, rankIdx: 1 }, { unique: true, name: 'playerId_rankIdx_unique' });
  await database.collection('leaderboard').createIndex({ score: -1, playedAt: 1 }, { name: 'score_playedAt' });
  await database.collection('leaderboard').createIndex({ playerId: 1, mode: 1 }, { unique: true, name: 'playerId_mode_unique' });
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect() {
  const uri = process.env.MONGODB_URI;
  const isPlaceholder = !uri || uri.includes('<username>') || uri.includes('<password>');

  if (!isPlaceholder) {
    try {
      console.log('[mongo] Attempting connection to MongoDB Atlas...');
      const { MongoClient } = require('mongodb');
      _client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
      await _client.connect();
      _db = _client.db('number_snake_db');
      await ensureIndexes(_db);
      _isAtlas = true;
      console.log('[mongo] Connected to MongoDB Atlas (number_snake_db). Indexes verified.');
      return;
    } catch (err) {
      console.warn('[mongo] Could not use Atlas (' + err.message + '). Falling back to persistent local storage.');
      _isAtlas = false;
      _db = null;
      if (_client) { try { await _client.close(); } catch (e) { /* ignore */ } }
      _client = null;
    }
  } else {
    console.log('[mongo] Placeholder MONGODB_URI detected. Using persistent local storage (data/db.json).');
    console.log('[mongo] To connect to MongoDB Atlas, put your real credentials in .env.');
  }
  await ensureIndexes(localDb());
}

function db() {
  return _isAtlas && _db ? _db : localDb();
}

function isAtlasConnected() { return _isAtlas; }
function getClient() { return _client; }

async function close() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _isAtlas = false;
    console.log('[mongo] Connection closed.');
  }
}

module.exports = { connect, db, isAtlasConnected, getClient, close, LocalDb, ensureIndexes };
