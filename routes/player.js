/* routes/player.js
   POST /api/player  — save or change this device's player name (no sign-in)
   GET  /api/player  — this device's name, best scores, recent runs and counts */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/mongo');
const svc = require('../lib/service');

const router = express.Router();

const nameLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

router.post('/', nameLimiter, async (req, res) => {
  try {
    const { playerId, name } = req.body || {};
    if (!svc.validPlayerId(playerId)) return res.status(400).json({ error: 'A valid playerId is required.' });
    const clean = svc.sanitizeName(name);
    if (!clean) return res.status(400).json({ error: 'Please enter a name.' });
    const player = await svc.upsertPlayer(db(), playerId, clean);
    return res.json({ ok: true, player });
  } catch (err) {
    console.error('[player] Save error:', err.message);
    return res.status(500).json({ error: 'Could not save the name.' });
  }
});

router.get('/', async (req, res) => {
  try {
    const playerId = String(req.query.playerId || '');
    if (!svc.validPlayerId(playerId)) return res.status(400).json({ error: 'A valid playerId is required.' });
    const data = await svc.getPlayer(db(), playerId);
    return res.json({ ok: true, playerId, ...data });
  } catch (err) {
    console.error('[player] Get error:', err.message);
    return res.status(500).json({ error: 'Could not load the player.' });
  }
});

module.exports = router;
