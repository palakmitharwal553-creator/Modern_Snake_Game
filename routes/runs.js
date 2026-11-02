/* routes/runs.js
   POST /api/runs — record a completed game run.
   Supports authenticated users as well as guest submissions. */

'use strict';

const express = require('express');
const { ObjectId } = require('mongodb');
const { db } = require('../db/mongo');

const router = express.Router();

const VALID_MODES = ['normal', 'nowalls'];
const VALID_RANK_NAMES = ['Rookie', 'Explorer', 'Skilled', 'Pro', 'Expert', 'Legend'];
const MAX_SCORE = 500;

router.post('/', async (req, res) => {
  try {
    const { score, mode, rankIdx, rankName, reason } = req.body || {};

    // Validation
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }

    const cleanRankIdx = Math.max(0, Math.min(5, parseInt(rankIdx, 10) || 0));
    const cleanRankName = VALID_RANK_NAMES[cleanRankIdx] || 'Rookie';
    const playedAt = new Date();

    const playerId = (req.session && req.session.userId)
      ? req.session.userId
      : (req.body.playerId || 'guest_' + Math.random().toString(36).slice(2, 8));

    let nickname = (req.body.nickname || 'Player').replace(/<[^>]*>/g, '').trim().slice(0, 25) || 'Player';

    if (req.session && req.session.userId) {
      try {
        const u = await db().collection('users').findOne({ _id: new ObjectId(req.session.userId) });
        if (u && u.username) nickname = u.username;
      } catch {
        // fallback
      }
    }

    const runDoc = {
      playerId,
      userId: (req.session && req.session.userId) ? new ObjectId(req.session.userId) : null,
      nickname,
      score,
      mode,
      rankIdx: cleanRankIdx,
      rankName: cleanRankName,
      reason: String(reason || 'over').slice(0, 20),
      playedAt
    };

    await db().collection('game_runs').insertOne(runDoc);

    // Update leaderboard entry if score is higher
    const existing = await db().collection('leaderboard').findOne({ playerId, mode });
    if (!existing) {
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
    }

    // Update user best if logged in
    if (req.session && req.session.userId) {
      const bestField = `bestScores.${mode}`;
      await db().collection('users').updateOne(
        { _id: new ObjectId(req.session.userId), [bestField]: { $lt: score } },
        { $set: { [bestField]: score, updatedAt: playedAt } }
      );
    }

    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[runs] Save run error:', err.message);
    return res.status(500).json({ error: 'Could not save the run.' });
  }
});

module.exports = router;
