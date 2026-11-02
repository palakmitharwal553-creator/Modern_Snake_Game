/* routes/certs.js
   POST /api/certs - record that a device downloaded a certificate.

   The PNG itself is still drawn entirely in the browser. This endpoint only
   stores a metadata record. A unique index on (deviceId, rankIdx) keeps one
   record per device and milestone. Older records created by the account
   system are left untouched. */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/mongo');

const router = express.Router();

const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Must match the RANKS array in script.js: Pro (50), Expert (80), Legend (120).
const VALID_RANK_IDX = [3, 4, 5];
const VALID_RANK_NAMES = { 3: 'Pro', 4: 'Expert', 5: 'Legend' };
const VALID_MODES = ['Normal', 'No walls'];
const MAX_SCORE = 600;
const MAX_NAME_LEN = 30;

const certLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

router.post('/', certLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const rawId = req.get('x-device-id') || body.deviceId || '';
    if (typeof rawId !== 'string' || !DEVICE_ID_RE.test(rawId)) {
      return res.status(400).json({ error: 'A valid deviceId is required.' });
    }
    const deviceId = rawId.toLowerCase();

    const { rankIdx, rankName, score, mode, playerName } = body;
    if (!VALID_RANK_IDX.includes(rankIdx)) {
      return res.status(400).json({ error: 'Invalid rankIdx for a certificate.' });
    }
    if (VALID_RANK_NAMES[rankIdx] !== rankName) {
      return res.status(400).json({ error: 'Invalid rankName.' });
    }
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }
    const safeName = (typeof playerName === 'string' ? playerName : '')
      .replace(/<[^>]*>/g, '')
      .replace(/[\u0000-\u001f\u007f-\u009f<>]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LEN) || 'Player';

    const player = await db().collection('players').findOne({ deviceId }, { projection: { _id: 1 } });
    if (!player) {
      return res.status(404).json({ error: 'Player not found. Register this device first.', code: 'NOT_REGISTERED' });
    }

    const issuedAt = new Date();
    await db().collection('certificates').updateOne(
      { deviceId, rankIdx },
      {
        $set: { rankName, score, mode, playerName: safeName, issuedAt },
        $setOnInsert: { deviceId, rankIdx, createdAt: issuedAt }
      },
      { upsert: true }
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'Certificate record already exists for this milestone.' });
    }
    console.error('[certs] save error:', err.message);
    return res.status(500).json({ error: 'Could not save the certificate record.' });
  }
});

module.exports = router;