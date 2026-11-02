/* db/mongo.js
   MongoDB Atlas connection manager for Number Snake (number_snake_db).
   Supports MongoDB Atlas with automatic fallback to persistent JSON storage
   (data/db.json) if Atlas credentials are placeholder or network is unavailable,
   ensuring the application never crashes and scores always persist. */

'use strict';

const fs = require('fs');
const path = require('path');
const { MongoClient, ObjectId } = require('mongodb');

const DATA_DIR = path.join(__dirname, '..', 'data');
const LOCAL_DB_PATH = path.join(DATA_DIR, 'db.json');

// Ensure data directory exists for persistent fallback storage
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let _client = null;
let _db = null;
let _isAtlas = false;

// ---------------------------------------------------------------------------
// Persistent Local Database Fallback (used when Atlas is not yet reachable)
// ---------------------------------------------------------------------------
class LocalCollection {
  constructor(name) {
    this.name = name;
  }

  _readAll() {
    try {
      if (!fs.existsSync(LOCAL_DB_PATH)) return {};
      const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }

  _writeAll(data) {
    try {
      fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.error('[local-db] Failed to write:', err.message);
    }
  }

  _getItems() {
    const all = this._readAll();
    return all[this.name] || [];
  }

  _setItems(items) {
    const all = this._readAll();
    all[this.name] = items;
    this._writeAll(all);
  }

  async findOne(query = {}) {
    const items = this._getItems();
    return items.find(item => this._matches(item, query)) || null;
  }

  find(query = {}) {
    const items = this._getItems().filter(item => this._matches(item, query));
    return {
      _items: items,
      sort(sortObj = {}) {
        const keys = Object.keys(sortObj);
        this._items.sort((a, b) => {
          for (const key of keys) {
            const dir = sortObj[key];
            const valA = a[key];
            const valB = b[key];
            if (valA < valB) return dir > 0 ? -1 : 1;
            if (valA > valB) return dir > 0 ? 1 : -1;
          }
          return 0;
        });
        return this;
      },
      limit(n) {
        if (typeof n === 'number' && n > 0) {
          this._items = this._items.slice(0, n);
        }
        return this;
      },
      async toArray() {
        return this._items;
      }
    };
  }

  async insertOne(doc) {
    const items = this._getItems();
    const newDoc = {
      _id: doc._id || new ObjectId().toString(),
      ...doc
    };
    items.push(newDoc);
    this._setItems(items);
    return { insertedId: newDoc._id };
  }

  async updateOne(query, update, options = {}) {
    const items = this._getItems();
    const idx = items.findIndex(item => this._matches(item, query));
    if (idx >= 0) {
      if (update.$set) Object.assign(items[idx], update.$set);
      if (update.$setOnInsert && options.upsert) Object.assign(items[idx], update.$setOnInsert);
      this._setItems(items);
      return { matchedCount: 1, modifiedCount: 1 };
    } else if (options.upsert) {
      const newDoc = {
        _id: new ObjectId().toString(),
        ...(query._id ? { _id: query._id.toString() } : {}),
        ...(update.$setOnInsert || {}),
        ...(update.$set || {})
      };
      items.push(newDoc);
      this._setItems(items);
      return { matchedCount: 0, upsertedCount: 1, upsertedId: newDoc._id };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }

  async countDocuments(query = {}) {
    return this._getItems().filter(item => this._matches(item, query)).length;
  }

  async createIndex() {
    return true; // no-op for file db
  }

  _matches(item, query) {
    for (const k of Object.keys(query)) {
      if (k === '_id') {
        const qId = query._id ? query._id.toString() : '';
        const iId = item._id ? item._id.toString() : '';
        if (qId !== iId) return false;
      } else if (query[k] && typeof query[k] === 'object' && query[k].$lt !== undefined) {
        if (!(item[k] < query[k].$lt)) return false;
      } else if (item[k] !== query[k]) {
        return false;
      }
    }
    return true;
  }
}

class LocalDb {
  collection(name) {
    return new LocalCollection(name);
  }
}

const _localDbInstance = new LocalDb();

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
async function connect() {
  const uri = process.env.MONGODB_URI;
  const isPlaceholder = !uri || uri.includes('<username>') || uri.includes('<password>');

  if (!isPlaceholder) {
    try {
      console.log('[mongo] Attempting connection to MongoDB Atlas...');
      _client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 4000
      });
      await _client.connect();
      _db = _client.db('number_snake_db');
      _isAtlas = true;
      console.log('[mongo] Successfully connected to MongoDB Atlas (number_snake_db).');

      // Ensure indexes on Atlas
      await _db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
      await _db.collection('game_runs').createIndex({ userId: 1, playedAt: -1 }, { name: 'userId_playedAt' });
      await _db.collection('game_runs').createIndex({ playerId: 1, playedAt: -1 }, { name: 'playerId_playedAt' });
      await _db.collection('certificates').createIndex({ userId: 1, issuedAt: -1 }, { name: 'userId_issuedAt' });
      await _db.collection('certificates').createIndex({ userId: 1, rankIdx: 1 }, { unique: true, sparse: true, name: 'userId_rankIdx_unique' });
      await _db.collection('leaderboard').createIndex({ score: -1, playedAt: 1 }, { name: 'score_playedAt' });
      await _db.collection('leaderboard').createIndex({ playerId: 1, mode: 1 }, { unique: true, name: 'playerId_mode_unique' });
      console.log('[mongo] Atlas indexes verified.');
      return;
    } catch (err) {
      console.warn('[mongo] Could not connect to Atlas (' + err.message + '). Falling back to persistent local storage.');
      _isAtlas = false;
      _db = null;
    }
  } else {
    console.log('[mongo] Placeholder MONGODB_URI detected. Using persistent local storage (data/db.json).');
    console.log('[mongo] To connect to MongoDB Atlas, update .env with your real credentials.');
  }
}

function db() {
  if (_isAtlas && _db) {
    return _db;
  }
  return _localDbInstance;
}

function isAtlasConnected() {
  return _isAtlas;
}

function getClient() {
  return _client;
}

async function close() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    _isAtlas = false;
    console.log('[mongo] Connection closed.');
  }
}

module.exports = {
  connect,
  db,
  isAtlasConnected,
  getClient,
  close
};
