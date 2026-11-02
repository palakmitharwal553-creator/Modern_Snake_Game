/* routes/certs.js
   POST /api/certs — record that this device downloaded a certificate.

   The PNG is still drawn in the browser. This only stores a small record. One record per
   device and milestone (unique index on playerId + rankIdx). The server checks that the
   device really has a saved score at or above the milestone. */

'use strict';

const express = require('express');
const { db } = require('../db/mongo');
const svc = require('../lib/service');

const router = express.Router();

router.post('/', async (req, res) => {
  try {
    const { playerId, rankIdx, score, mode, playerName } = req.body || {};

    if (!svc.validPlayerId(playerId)) return res.status(400).json({ error: 'A valid playerId is required.' });
    if (!svc.CERT_RANK_IDX.includes(rankIdx)) return res.status(400).json({ error: 'Invalid rankIdx for a certificate.' });
    if (!svc.validScore(score) || score < svc.RANKS[rankIdx].min) return res.status(400).json({ error: 'Invalid score.' });
    if (!svc.VALID_MODES.includes(mode)) return res.status(400).json({ error: 'Invalid mode.' });
    const name = svc.sanitizeName(playerName);
    if (!name) return res.status(400).json({ error: 'Please choose a name first.' });

    const out = await svc.recordCertificate(db(), { playerId, name, rankIdx, score, mode });
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.status(201).json({ ok: true });
  } catch (err) {
    console.error('[certs] Save cert error:', err.message);
    return res.status(500).json({ error: 'Could not save the certificate record.' });
  }
});

module.exports = router;
