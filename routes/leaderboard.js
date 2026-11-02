/* routes/leaderboard.js
   Device-based players and ONE global leaderboard (all game modes together).

   - GET  /api/leaderboard          top players (max 50) + the caller's own rank
   - GET  /api/leaderboard/player   the caller's profile, stats and global rank
   - POST /api/leaderboard/player   register this device (idempotent)
   - PUT  /api/leaderboard/player/name   change the display name
   - POST /api/leaderboard/submit   submit one completed game
   - GET  /api/leaderboard/stats    overall statistics

   The caller is identified by the Device ID the browser generated
   (crypto.randomUUID). There are no accounts or passwords. The Device ID is
   treated like a secret: it is never returned in any leaderboard response.
   Ranks are always calculated here on the server. */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db, getClient } = require('../db/mongo');

const router = express.Router();

// ---------------------------------------------------------------------------
// Constants and rate limits
// ---------------------------------------------------------------------------
const VALID_MODES = ['normal', 'nowalls'];
const MAX_SCORE = 600;            // 24 x 24 board: 574 is the theoretical maximum
const NAME_MAX = 25;
const TOP_MAX = 50;

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GAME_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LEGACY_ID_RE = /^p_[a-z0-9_]{4,60}$/;

function limiter(windowMs, max, message) {
  return rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false, message: { error: message } });
}
const readLimiter = limiter(5 * 60 * 1000, 300, 'Too many requests. Please slow down.');
const submitLimiter = limiter(10 * 60 * 1000, 60, 'Too many score submissions. Please slow down.');
const profileLimiter = limiter(10 * 60 * 1000, 20, 'Too many profile changes. Please try again later.');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const players = () => db().collection('players');

/** Display names: plain text only, 1-25 characters. Returns '' when nothing usable is left. */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
}

/** Device ID from the X-Device-Id header (preferred) or the JSON body. */
function getDeviceId(req) {
  const raw = req.get('x-device-id') || (req.body && req.body.deviceId) || '';
  return typeof raw === 'string' && DEVICE_ID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** 1 + number of players that sort ahead of this one. Unranked (no score yet) -> null. */
async function rankOf(p) {
  if (!p || !(p.bestScore > 0)) return null;
  const ahead = await players().countDocuments({
    $or: [
      { bestScore: { $gt: p.bestScore } },
      { bestScore: p.bestScore, bestScoreAchievedAt: { $lt: p.bestScoreAchievedAt } },
      { bestScore: p.bestScore, bestScoreAchievedAt: p.bestScoreAchievedAt, _id: { $lt: p._id } }
    ]
  });
  return ahead + 1;
}

function totalRanked() {
  return players().countDocuments({ bestScore: { $gt: 0 } });
}

function movementOf(previousRank, rank) {
  if (rank === null) return { movement: 'unranked', change: 0 };
  if (previousRank === null) return { movement: 'entered', change: 0 };
  if (rank < previousRank) return { movement: 'up', change: previousRank - rank };
  if (rank > previousRank) return { movement: 'down', change: rank - previousRank };
  return { movement: 'same', change: 0 };
}

/** Public view of a player. Never includes deviceId or legacyPlayerId. */
function publicPlayer(p, rank) {
  return {
    displayName: p.displayName,
    rank: rank === undefined ? null : rank,
    bestScore: p.bestScore || 0,
    bestMode: p.bestMode || null,
    bestScoreAchievedAt: p.bestScoreAchievedAt || null,
    latestScore: p.latestScore === undefined ? null : p.latestScore,
    latestMode: p.latestMode || null,
    gamesPlayed: p.gamesPlayed || 0,
    lastPlayedAt: p.lastPlayedAt || null,
    createdAt: p.createdAt || null
  };
}

/** Best result an older (pre-device) leaderboard record set has for this legacy player id. */
async function readLegacy(legacyId) {
  const entries = await db().collection('leaderboard').find({ playerId: legacyId }).toArray();
  if (!entries.length) return null;
  entries.sort((a, b) => (b.score - a.score) || (new Date(a.playedAt) - new Date(b.playedAt)));
  const top = entries[0];
  const gamesPlayed = await db().collection('game_runs').countDocuments({ playerId: legacyId });
  return { score: top.score, mode: top.mode, playedAt: new Date(top.playedAt), gamesPlayed };
}

// ---------------------------------------------------------------------------
// POST /api/leaderboard/player  - register this device (idempotent)
// ---------------------------------------------------------------------------
router.post('/player', profileLimiter, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(400).json({ error: 'A valid deviceId is required.' });

    const existing = await players().findOne({ deviceId });
    if (existing) {
      return res.json({ ok: true, created: false, player: publicPlayer(existing, await rankOf(existing)) });
    }

    const displayName = sanitizeName(req.body && req.body.displayName);
    if (!displayName) return res.status(400).json({ error: 'Please enter a display name (1-25 characters).' });

    const now = new Date();
    const doc = {
      deviceId,
      displayName,
      bestScore: 0,
      bestMode: null,
      bestScoreAchievedAt: null,
      latestScore: null,
      latestMode: null,
      gamesPlayed: 0,
      lastPlayedAt: null,
      createdAt: now,
      updatedAt: now
    };

    // Optionally carry over an older anonymous leaderboard record (read-only: nothing is modified or deleted).
    const legacyId = req.body && req.body.legacyPlayerId;
    let legacy = null;
    if (typeof legacyId === 'string' && LEGACY_ID_RE.test(legacyId)) {
      legacy = await readLegacy(legacyId);
      if (legacy) {
        doc.legacyPlayerId = legacyId;
        doc.bestScore = legacy.score;
        doc.bestMode = legacy.mode;
        doc.bestScoreAchievedAt = legacy.playedAt;
        doc.gamesPlayed = legacy.gamesPlayed;
      }
    }

    let created = true;
    let player = doc;
    try {
      const r = await players().insertOne(doc);
      player = { ...doc, _id: r.insertedId };
    } catch (err) {
      if (!err || err.code !== 11000) throw err;
      const pattern = err.keyPattern || {};
      if (pattern.legacyPlayerId) {
        // Someone already claimed that legacy record: register without it.
        delete doc.legacyPlayerId;
        doc.bestScore = 0; doc.bestMode = null; doc.bestScoreAchievedAt = null; doc.gamesPlayed = 0;
        try {
          const r = await players().insertOne(doc);
          player = { ...doc, _id: r.insertedId };
        } catch (err2) {
          if (!err2 || err2.code !== 11000) throw err2;
          created = false;
          player = await players().findOne({ deviceId });
        }
      } else {
        // The same device registered twice at once: keep the first record.
        created = false;
        player = await players().findOne({ deviceId });
      }
    }
    return res.status(created ? 201 : 200).json({ ok: true, created, player: publicPlayer(player, await rankOf(player)) });
  } catch (err) {
    console.error('[leaderboard] register error:', err.message);
    return res.status(500).json({ error: 'Could not save the player profile.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard/player  - profile + global rank of the calling device
// ---------------------------------------------------------------------------
router.get('/player', readLimiter, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(400).json({ error: 'A valid deviceId is required.' });
    const p = await players().findOne({ deviceId });
    if (!p) return res.json({ ok: true, registered: false, player: null });
    return res.json({ ok: true, registered: true, player: publicPlayer(p, await rankOf(p)), totalPlayers: await totalRanked() });
  } catch (err) {
    console.error('[leaderboard] player error:', err.message);
    return res.status(500).json({ error: 'Could not load the player profile.' });
  }
});

// ---------------------------------------------------------------------------
// PUT /api/leaderboard/player/name  - edit the display name
// ---------------------------------------------------------------------------
router.put('/player/name', profileLimiter, async (req, res) => {
  try {
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(400).json({ error: 'A valid deviceId is required.' });
    const displayName = sanitizeName(req.body && req.body.displayName);
    if (!displayName) return res.status(400).json({ error: 'Please enter a display name (1-25 characters).' });

    const p = await players().findOneAndUpdate(
      { deviceId },
      { $set: { displayName, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );
    if (!p) return res.status(404).json({ error: 'Player not found. Register this device first.', code: 'NOT_REGISTERED' });
    return res.json({ ok: true, player: publicPlayer(p, await rankOf(p)) });
  } catch (err) {
    console.error('[leaderboard] rename error:', err.message);
    return res.status(500).json({ error: 'Could not update the display name.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/leaderboard/submit  - one completed game
// ---------------------------------------------------------------------------
router.post('/submit', submitLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(400).json({ error: 'A valid deviceId is required.' });

    const { score, mode, gameId } = body;
    if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) {
      return res.status(400).json({ error: 'A valid gameId is required.' });
    }
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }

    const player = await players().findOne({ deviceId });
    if (!player) {
      return res.status(404).json({ error: 'Player not found. Register this device first.', code: 'NOT_REGISTERED' });
    }

    // The server clock is authoritative for achievement times. The client time is only stored for reference.
    const now = new Date();
    let clientPlayedAt = null;
    if (body.playedAt) {
      const t = new Date(body.playedAt);
      if (!isNaN(t.getTime()) && t.getTime() <= now.getTime() + 5 * 60 * 1000 && t.getTime() >= now.getTime() - 48 * 3600 * 1000) {
        clientPlayedAt = t;
      }
    }

    const previousRank = await rankOf(player);

    // Insert the run and update the player in ONE transaction. The unique
    // (deviceId, gameId) index rejects a duplicate submission, which aborts
    // the transaction so nothing is counted twice.
    const runDoc = {
      deviceId,
      gameId,
      nickname: player.displayName,
      score,
      mode,
      playedAt: now,
      clientPlayedAt
    };
    const lit = (v) => ({ $literal: v });
    const pipeline = [
      { $set: { _isNewBest: { $gt: [lit(score), { $ifNull: ['$bestScore', 0] }] } } },
      {
        $set: {
          gamesPlayed: { $add: [{ $ifNull: ['$gamesPlayed', 0] }, 1] },
          latestScore: lit(score),
          latestMode: lit(mode),
          lastPlayedAt: lit(now),
          updatedAt: lit(now),
          bestScore: { $cond: ['$_isNewBest', lit(score), { $ifNull: ['$bestScore', 0] }] },
          bestMode: { $cond: ['$_isNewBest', lit(mode), { $ifNull: ['$bestMode', null] }] },
          bestScoreAchievedAt: { $cond: ['$_isNewBest', lit(now), { $ifNull: ['$bestScoreAchievedAt', null] }] },
          lastBestGameId: { $cond: ['$_isNewBest', lit(gameId), { $ifNull: ['$lastBestGameId', null] }] }
        }
      },
      { $unset: '_isNewBest' }
    ];

    let after = null;
    const session = getClient().startSession();
    try {
      await session.withTransaction(async () => {
        await db().collection('game_runs').insertOne(runDoc, { session });
        after = await players().findOneAndUpdate({ deviceId }, pipeline, { session, returnDocument: 'after' });
        if (!after) throw Object.assign(new Error('Player vanished'), { code: 'PLAYER_GONE' });
      });
    } catch (err) {
      if (err && err.code === 11000) {
        // Duplicate gameId: already recorded, change nothing.
        const current = await players().findOne({ deviceId });
        const rank = await rankOf(current);
        return res.json({
          ok: true, duplicate: true, score, mode, rank, previousRank: rank,
          movement: 'same', change: 0, isNewBest: false,
          totalPlayers: await totalRanked(), player: publicPlayer(current, rank)
        });
      }
      if (err && err.code === 'PLAYER_GONE') {
        return res.status(404).json({ error: 'Player not found. Register this device first.', code: 'NOT_REGISTERED' });
      }
      throw err;
    } finally {
      await session.endSession();
    }

    const rank = await rankOf(after);
    const { movement, change } = movementOf(previousRank, rank);
    return res.status(201).json({
      ok: true,
      duplicate: false,
      score,
      mode,
      isNewBest: after.lastBestGameId === gameId,
      previousRank,
      rank,
      movement,
      change,
      totalPlayers: await totalRanked(),
      player: publicPlayer(after, rank)
    });
  } catch (err) {
    console.error('[leaderboard] submit error:', err.message);
    return res.status(500).json({ error: 'Failed to record score.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard  - top players + the caller's own rank
// ---------------------------------------------------------------------------
router.get('/', readLimiter, async (req, res) => {
  try {
    const limit = Math.min(TOP_MAX, Math.max(1, parseInt(req.query.limit, 10) || TOP_MAX));
    const deviceId = getDeviceId(req);

    const docs = await players()
      .find({ bestScore: { $gt: 0 } })
      .sort({ bestScore: -1, bestScoreAchievedAt: 1, _id: 1 })
      .limit(limit)
      .project({ displayName: 1, bestScore: 1, bestMode: 1, bestScoreAchievedAt: 1, deviceId: 1 })
      .toArray();

    const entries = docs.map((d, i) => ({
      rank: i + 1,
      displayName: d.displayName,
      bestScore: d.bestScore,
      bestMode: d.bestMode,
      bestScoreAchievedAt: d.bestScoreAchievedAt,
      isMe: !!deviceId && d.deviceId === deviceId
    }));

    // The caller's own rank, even when they are outside the top list.
    let me = null;
    if (deviceId) {
      const mine = await players().findOne({ deviceId });
      if (mine) me = publicPlayer(mine, await rankOf(mine));
    }

    return res.json({ ok: true, entries, me, totalPlayers: await totalRanked() });
  } catch (err) {
    console.error('[leaderboard] list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard/stats
// ---------------------------------------------------------------------------
router.get('/stats', readLimiter, async (req, res) => {
  try {
    const top = await players().find({ bestScore: { $gt: 0 } }).sort({ bestScore: -1 }).limit(1).toArray();
    return res.json({
      ok: true,
      totalPlayers: await totalRanked(),
      totalRuns: await db().collection('game_runs').countDocuments(),
      totalCertificates: await db().collection('certificates').countDocuments(),
      topScore: top[0] ? top[0].bestScore : 0
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
});

module.exports = router;