/* routes/leaderboard.js
   GET  /api/leaderboard        — top rankings (mode = normal | nowalls | all)
   POST /api/leaderboard/submit — send the score of a finished game (device id + name, no sign-in)
   GET  /api/leaderboard/player — one device's best scores, recent runs and counts
   GET  /api/leaderboard/stats  — overall statistics */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/mongo');
const svc = require('../lib/service');

const router = express.Router();

const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please slow down.' }
});

// Remembers recent run tokens so a retry of the same game is not counted twice.
const recentTokens = new Map();
const tokenTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, exp] of recentTokens.entries()) if (exp <= now) recentTokens.delete(token);
}, 60000);
if (tokenTimer.unref) tokenTimer.unref();

router.get('/', async (req, res) => {
  try {
    const mode = String(req.query.mode || 'all').toLowerCase();
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const playerId = svc.validPlayerId(String(req.query.playerId || '')) ? String(req.query.playerId) : null;
    const data = await svc.getLeaderboard(db(), { mode, limit, playerId });
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[leaderboard] GET error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

router.post('/submit', submitLimiter, async (req, res) => {
  try {
    const { playerId, nickname, score, mode, runToken } = req.body || {};

    if (!svc.validPlayerId(playerId)) return res.status(400).json({ error: 'A valid playerId is required.' });
    if (!svc.validScore(score)) return res.status(400).json({ error: 'Invalid score.' });
    if (!svc.VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
    const name = svc.sanitizeName(nickname);
    if (!name) return res.status(400).json({ error: 'Please choose a name first.' });

    if (runToken) {
      const key = playerId + '_' + String(runToken).slice(0, 80);
      if (recentTokens.has(key)) return res.json({ ok: true, duplicateIgnored: true });
      recentTokens.set(key, Date.now() + 60000);
    }

    const result = await svc.submitScore(db(), { playerId, name, score, mode });
    return res.status(201).json({ ok: true, ...result });
  } catch (err) {
    console.error('[leaderboard] Submit error:', err.message);
    return res.status(500).json({ error: 'Failed to record score.' });
  }
});

router.get('/player', async (req, res) => {
  try {
    const playerId = String(req.query.playerId || '');
    if (!svc.validPlayerId(playerId)) return res.status(400).json({ error: 'A valid playerId is required.' });
    const data = await svc.getPlayer(db(), playerId);
    return res.json({ ok: true, playerId, ...data });
  } catch (err) {
    console.error('[leaderboard] Player query error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch player stats.' });
  }
});

router.get('/stats', async (req, res) => {
  try {
    return res.json({ ok: true, ...(await svc.getStats(db())) });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch statistics.' });
  }
});

module.exports = router;
