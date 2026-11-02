/* routes/leaderboard.js
   Full-featured Leaderboard API for Number Snake:
   - GET  /api/leaderboard        — Fetch top rankings (filtered by mode: all/normal/nowalls)
   - POST /api/leaderboard/submit — Submit game score with server validation & deduplication
   - GET  /api/leaderboard/player — Get a player's best scores and current ranks
   - GET  /api/leaderboard/stats  — Overall game statistics */

'use strict';

const express = require('express');
const { ObjectId } = require('mongodb');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/mongo');

const router = express.Router();

// Rate limiting for score submissions: max 40 submissions per 10 minutes per IP
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please slow down.' }
});

const VALID_MODES = ['normal', 'nowalls'];
const VALID_RANK_NAMES = ['Rookie', 'Explorer', 'Skilled', 'Pro', 'Expert', 'Legend'];
const MAX_ALLOWED_SCORE = 500;
const MAX_NICK_LEN = 25;

// In-memory cache of recent submission tokens to avoid duplicate submissions
const recentTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of recentTokens.entries()) {
    if (exp <= now) recentTokens.delete(token);
  }
}, 60000);

/**
 * Sanitize nickname string: remove HTML tags, trim, enforce length
 */
function sanitizeNickname(raw) {
  if (typeof raw !== 'string') return 'Player';
  const clean = raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .trim()
    .slice(0, MAX_NICK_LEN);
  return clean || 'Player';
}

// ---------------------------------------------------------------------------
// GET /api/leaderboard
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const mode = (req.query.mode || 'all').toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const targetPlayerId = req.query.playerId ? String(req.query.playerId).trim() : null;

    const query = {};
    if (mode === 'normal' || mode === 'nowalls') {
      query.mode = mode;
    }

    // Fetch all leaderboard entries matching filter
    const allEntries = await db()
      .collection('leaderboard')
      .find(query)
      .sort({ score: -1, playedAt: 1 })
      .toArray();

    // Deduplicate so each player appears only once per mode (or their single absolute best if mode=all)
    const playerMap = new Map();
    for (const item of allEntries) {
      const key = mode === 'all' ? item.playerId : `${item.playerId}_${item.mode}`;
      if (!playerMap.has(key)) {
        playerMap.set(key, item);
      } else {
        const existing = playerMap.get(key);
        if (item.score > existing.score) {
          playerMap.set(key, item);
        }
      }
    }

    // Sort unique player scores: score DESC, playedAt ASC (earlier is tiebreaker)
    const sorted = Array.from(playerMap.values()).sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const tA = new Date(a.playedAt || 0).getTime();
      const tB = new Date(b.playedAt || 0).getTime();
      return tA - tB;
    });

    // Assign rank numbers (1, 2, 3...)
    let myRankInfo = null;
    const rankedList = sorted.map((entry, idx) => {
      const rankNum = idx + 1;
      const formatted = {
        rank: rankNum,
        playerId: entry.playerId,
        nickname: entry.nickname || 'Player',
        score: entry.score,
        mode: entry.mode,
        rankIdx: entry.rankIdx,
        rankName: entry.rankName,
        playedAt: entry.playedAt
      };
      if (targetPlayerId && entry.playerId === targetPlayerId) {
        myRankInfo = formatted;
      }
      return formatted;
    });

    // Top N for display
    const topEntries = rankedList.slice(0, limit);

    return res.json({
      ok: true,
      mode,
      entries: topEntries,
      myRank: myRankInfo,
      totalPlayers: sorted.length
    });
  } catch (err) {
    console.error('[leaderboard] GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/leaderboard/submit
// ---------------------------------------------------------------------------
router.post('/submit', submitLimiter, async (req, res) => {
  try {
    const { score, mode, rankIdx, rankName, reason, runToken } = req.body || {};

    // Determine player ID and nickname
    let playerId = req.body.playerId;
    let nickname = sanitizeNickname(req.body.nickname);

    if (req.session && req.session.userId) {
      playerId = req.session.userId;
      // If user is authenticated, query user's official username
      try {
        const u = await db().collection('users').findOne({ _id: new ObjectId(playerId) });
        if (u && u.username) nickname = u.username;
      } catch {
        // fallback to provided nickname
      }
    }

    if (!playerId) {
      return res.status(400).json({ error: 'playerId is required.' });
    }

    // Server-side validation
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_ALLOWED_SCORE) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }
    const cleanRankIdx = Math.max(0, Math.min(5, parseInt(rankIdx, 10) || 0));
    const cleanRankName = VALID_RANK_NAMES[cleanRankIdx] || 'Rookie';
    const cleanReason = String(reason || 'over').slice(0, 20);

    // Prevent duplicate submission for identical token within 60s
    if (runToken) {
      const tokenKey = `${playerId}_${runToken}`;
      if (recentTokens.has(tokenKey)) {
        return res.json({ ok: true, duplicateIgnored: true });
      }
      recentTokens.set(tokenKey, Date.now() + 60000);
    }

    const playedAt = new Date();

    // 1. Always record in game_runs collection
    const runDoc = {
      playerId,
      userId: (req.session && req.session.userId) ? new ObjectId(req.session.userId) : null,
      nickname,
      score,
      mode,
      rankIdx: cleanRankIdx,
      rankName: cleanRankName,
      reason: cleanReason,
      playedAt
    };
    await db().collection('game_runs').insertOne(runDoc);

    // 2. Check existing score for this player and mode in leaderboard
    const existing = await db().collection('leaderboard').findOne({ playerId, mode });
    let isNewBest = false;

    if (!existing) {
      isNewBest = true;
      await db().collection('leaderboard').insertOne({
        playerId,
        nickname,
        score,
        mode,
        rankIdx: cleanRankIdx,
        rankName: cleanRankName,
        playedAt
      });
    } else if (score > existing.score) {
      isNewBest = true;
      await db().collection('leaderboard').updateOne(
        { playerId, mode },
        {
          $set: {
            nickname,
            score,
            rankIdx: cleanRankIdx,
            rankName: cleanRankName,
            playedAt
          }
        }
      );
    } else {
      // Even if score is not higher, update display nickname if changed
      if (nickname !== existing.nickname) {
        await db().collection('leaderboard').updateOne(
          { playerId, mode },
          { $set: { nickname } }
        );
      }
    }

    // 3. Update registered user bestScores if logged in
    if (req.session && req.session.userId) {
      const bestField = `bestScores.${mode}`;
      await db().collection('users').updateOne(
        { _id: new ObjectId(req.session.userId), [bestField]: { $lt: score } },
        { $set: { [bestField]: score, updatedAt: playedAt } }
      );
    }

    // 4. Calculate current rank of this player in this mode
    const higherScores = await db().collection('leaderboard').countDocuments({
      mode,
      score: { $gt: isNewBest ? score : existing.score }
    });
    const currentRank = higherScores + 1;

    return res.status(201).json({
      ok: true,
      score,
      mode,
      rank: currentRank,
      isNewBest
    });
  } catch (err) {
    console.error('[leaderboard] Submit error:', err.message);
    return res.status(500).json({ error: 'Failed to record score.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard/player
// ---------------------------------------------------------------------------
router.get('/player', async (req, res) => {
  try {
    const playerId = req.query.playerId || (req.session && req.session.userId);
    if (!playerId) {
      return res.status(400).json({ error: 'playerId required' });
    }

    const entries = await db().collection('leaderboard').find({ playerId }).toArray();
    const history = await db()
      .collection('game_runs')
      .find({ playerId })
      .sort({ playedAt: -1 })
      .limit(10)
      .toArray();

    return res.json({
      ok: true,
      playerId,
      bests: entries,
      history
    });
  } catch (err) {
    console.error('[leaderboard] Player query error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch player stats.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/leaderboard/stats
// ---------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const totalRuns = await db().collection('game_runs').countDocuments();
    const totalCertificates = await db().collection('certificates').countDocuments();
    const topNormal = await db().collection('leaderboard').find({ mode: 'normal' }).sort({ score: -1 }).limit(1).toArray();
    const topNoWalls = await db().collection('leaderboard').find({ mode: 'nowalls' }).sort({ score: -1 }).limit(1).toArray();

    return res.json({
      ok: true,
      totalRuns,
      totalCertificates,
      bestNormal: topNormal[0] ? topNormal[0].score : 0,
      bestNoWalls: topNoWalls[0] ? topNoWalls[0].score : 0
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
});

module.exports = router;
