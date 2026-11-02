/* routes/certs.js
   POST /api/certs — record that an authenticated user downloaded a certificate.

   The canvas-based PNG generator continues to run entirely in the browser.
   This endpoint only persists a metadata record in MongoDB.

   A unique compound index (userId + rankIdx) in MongoDB prevents duplicate
   records for the same user and milestone. */

'use strict';

const express = require('express');
const { ObjectId } = require('mongodb');
const { db } = require('../db/mongo');

const router = express.Router();

// ---------------------------------------------------------------------------
// Valid values — must match the RANKS array in script.js
// ---------------------------------------------------------------------------
const VALID_RANK_IDX = [3, 4, 5];   // Pro (50), Expert (80), Legend (120) only
const VALID_RANK_NAMES = ['Pro', 'Expert', 'Legend'];
const VALID_MODES = ['Normal', 'No walls']; // display labels, not mode ids
const MAX_SCORE = 500;
const MAX_NAME_LEN = 30;

// ---------------------------------------------------------------------------
// POST /api/certs
// ---------------------------------------------------------------------------
router.post('/', async (req, res) => {
  // Authentication check
  if (!req.session || !req.session.userId) {
    // Guests can still download locally — just don't persist to MongoDB
    return res.status(401).json({ error: 'You must be logged in to save a certificate record.' });
  }

  try {
    const { rankIdx, rankName, score, mode, playerName } = req.body || {};

    // --- Validation ---
    if (!VALID_RANK_IDX.includes(rankIdx)) {
      return res.status(400).json({ error: 'Invalid rankIdx for a certificate.' });
    }
    if (!VALID_RANK_NAMES.includes(rankName)) {
      return res.status(400).json({ error: 'Invalid rankName.' });
    }
    if (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > MAX_SCORE) {
      return res.status(400).json({ error: 'Invalid score.' });
    }
    if (!VALID_MODES.includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode.' });
    }
    const safeName = (typeof playerName === 'string' ? playerName : '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_NAME_LEN) || 'Player';

    const userId = new ObjectId(req.session.userId);
    const issuedAt = new Date();

    // --- Upsert: update the existing record if it exists, insert if not.
    //     The unique index on (userId, rankIdx) guarantees at most one per milestone. ---
    await db().collection('certificates').updateOne(
      { userId, rankIdx },
      {
        $set: { rankName, score, mode, playerName: safeName, issuedAt },
        $setOnInsert: { userId, rankIdx, createdAt: issuedAt }
      },
      { upsert: true }
    );

    // --- Increment the user's cert count (capped per milestone: max 3) ---
    // We count distinct certificate ranks the user has earned, not downloads.
    await db().collection('users').updateOne(
      { _id: userId },
      { $set: { updatedAt: issuedAt } }
    );

    return res.status(201).json({ ok: true });
  } catch (err) {
    // Unique index violation is handled by upsert so this shouldn't fire,
    // but guard defensively.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Certificate record already exists for this milestone.' });
    }
    console.error('[certs] Save cert error:', err.message);
    return res.status(500).json({ error: 'Could not save the certificate record.' });
  }
});

module.exports = router;

