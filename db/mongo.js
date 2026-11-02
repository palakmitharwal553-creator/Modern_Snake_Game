/* db/mongo.js
   MongoDB Atlas connection manager for Number Snake (database: number_snake_db).

   MongoDB is the only data store. There is NO local JSON fallback: if the
   connection fails the server refuses to start, so scores are never silently
   written somewhere that production cannot see.

   Collections used by the device-based leaderboard:
     players       one document per device (unique deviceId)
     game_runs     one document per completed game (unique deviceId + gameId)
     certificates  one document per device and milestone
   Older collections (users, leaderboard, sessions) are left untouched. */

'use strict';

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB || 'number_snake_db';

let _client = null;
let _db = null;

function isPlaceholder(uri) {
  return !uri || uri.includes('<username>') || uri.includes('<password>');
}

async function ensureIndexes(database) {
  // players: one record per device, plus the ranking index used for every rank query.
  await database.collection('players').createIndex(
    { deviceId: 1 }, { unique: true, name: 'deviceId_unique' }
  );
  await database.collection('players').createIndex(
    { bestScore: -1, bestScoreAchievedAt: 1, _id: 1 }, { name: 'ranking' }
  );
  // A legacy (pre-device) player id can be claimed by at most one device.
  await database.collection('players').createIndex(
    { legacyPlayerId: 1 },
    { unique: true, name: 'legacyPlayerId_unique', partialFilterExpression: { legacyPlayerId: { $type: 'string' } } }
  );

  // game_runs: the unique index is what rejects duplicate submissions.
  // It is partial so older runs without a gameId do not conflict with it.
  await database.collection('game_runs').createIndex(
    { deviceId: 1, gameId: 1 },
    { unique: true, name: 'deviceId_gameId_unique', partialFilterExpression: { gameId: { $type: 'string' } } }
  );
  await database.collection('game_runs').createIndex(
    { deviceId: 1, playedAt: -1 }, { name: 'deviceId_playedAt', partialFilterExpression: { deviceId: { $type: 'string' } } }
  );

  // certificates: one record per device and milestone.
  await database.collection('certificates').createIndex(
    { deviceId: 1, rankIdx: 1 },
    { unique: true, name: 'deviceId_rankIdx_unique', partialFilterExpression: { deviceId: { $type: 'string' } } }
  );
}

async function connect() {
  const uri = process.env.MONGODB_URI;
  if (isPlaceholder(uri)) {
    throw new Error(
      'MONGODB_URI is missing or still contains the <username>/<password> placeholders. ' +
      'Set your real MongoDB Atlas connection string in .env (see .env.example).'
    );
  }

  _client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await _client.connect();
    _db = _client.db(DB_NAME);
    await ensureIndexes(_db);
  } catch (err) {
    try { await _client.close(); } catch (_) { /* ignore */ }
    _client = null;
    _db = null;
    throw new Error('Could not connect to MongoDB Atlas: ' + err.message);
  }
  console.log('[mongo] Connected to MongoDB Atlas (' + DB_NAME + '). Indexes verified.');
}

function db() {
  if (!_db) throw new Error('Database is not connected.');
  return _db;
}

function getClient() {
  return _client;
}

function isAtlasConnected() {
  return !!_db;
}

async function close() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
    console.log('[mongo] Connection closed.');
  }
}

module.exports = { connect, db, getClient, isAtlasConnected, close };