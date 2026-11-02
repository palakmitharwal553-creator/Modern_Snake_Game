/* lib/service.js
   Game logic for the device-based player system. No Express in here, so it can be
   tested directly (see test/verify.js).

   One device = one player. The browser creates a random playerId once and keeps it, together
   with the chosen name, in localStorage. There are no accounts and no passwords. */

'use strict';

const VALID_MODES = ['normal', 'nowalls'];
const MODE_LABELS = { normal: 'Normal', nowalls: 'No walls' };
const RANKS = [
  { name: 'Rookie', min: 0 },
  { name: 'Explorer', min: 10 },
  { name: 'Skilled', min: 25 },
  { name: 'Pro', min: 50 },
  { name: 'Expert', min: 80 },
  { name: 'Legend', min: 120 }
];
const CERT_RANK_IDX = [3, 4, 5];       // certificates start at Pro (50+)
const MAX_SCORE = 500;
const MAX_NAME_LEN = 25;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function rankIndexFor(score) {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (score >= RANKS[i].min) idx = i;
  return idx;
}

/** Removes tags and control characters, collapses spaces, limits the length. Returns '' if nothing is left. */
function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LEN)
    .trim();
}

function validPlayerId(id) {
  return typeof id === 'string' && PLAYER_ID_RE.test(id);
}

function validScore(s) {
  return typeof s === 'number' && Number.isInteger(s) && s >= 0 && s <= MAX_SCORE;
}

function time(d) {
  return new Date(d || 0).getTime();
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/** Creates the player, or renames it. The new name is copied onto the leaderboard rows. */
async function upsertPlayer(db, playerId, name) {
  const now = new Date();
  const existing = await db.collection('players').findOne({ playerId });
  if (!existing) {
    try {
      await db.collection('players').insertOne({ playerId, name, createdAt: now, updatedAt: now });
    } catch (err) {
      if (err.code !== 11000) throw err;           // two requests created it at the same moment
      await db.collection('players').updateOne({ playerId }, { $set: { name, updatedAt: now } });
    }
  } else if (existing.name !== name) {
    await db.collection('players').updateOne({ playerId }, { $set: { name, updatedAt: now } });
  }
  if (!existing || existing.name !== name) {
    await db.collection('leaderboard').updateMany({ playerId }, { $set: { nickname: name } });
  }
  return { playerId, name };
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

/** Rank of an entry inside one mode: higher score first, earlier date wins a tie. */
async function rankInMode(db, mode, score, playedAt) {
  const higher = await db.collection('leaderboard').countDocuments({ mode, score: { $gt: score } });
  const earlierTie = await db.collection('leaderboard').countDocuments({ mode, score, playedAt: { $lt: playedAt } });
  return higher + earlierTie + 1;
}

async function submitScore(db, { playerId, name, score, mode }) {
  const player = await upsertPlayer(db, playerId, name);
  const playedAt = new Date();
  const rankIdx = rankIndexFor(score);

  await db.collection('game_runs').insertOne({
    playerId, nickname: player.name, score, mode, rankIdx, rankName: RANKS[rankIdx].name, playedAt
  });

  const row = { playerId, nickname: player.name, score, mode, rankIdx, rankName: RANKS[rankIdx].name, playedAt };
  let existing = await db.collection('leaderboard').findOne({ playerId, mode });
  let isNewBest = false;
  if (!existing) {
    try {
      await db.collection('leaderboard').insertOne(row);
      isNewBest = true;
    } catch (err) {
      if (err.code !== 11000) throw err;
      existing = await db.collection('leaderboard').findOne({ playerId, mode });
    }
  }
  if (existing) {
    if (score > existing.score) {
      // Atomic: only replaces the row while it is still lower than the new score
      await db.collection('leaderboard').updateOne(
        { playerId, mode, score: { $lt: score } },
        { $set: { nickname: player.name, score, rankIdx, rankName: RANKS[rankIdx].name, playedAt } }
      );
      isNewBest = true;
    }
  }

  const best = await db.collection('leaderboard').findOne({ playerId, mode });
  const rank = best ? await rankInMode(db, mode, best.score, best.playedAt) : 1;
  return { score, mode, rank, isNewBest, bestScore: best ? best.score : score, name: player.name };
}

/** mode: 'normal' | 'nowalls' | 'all'. 'all' shows each player once, with their best score in any mode. */
async function getLeaderboard(db, { mode = 'all', limit = 10, playerId = null }) {
  const query = VALID_MODES.includes(mode) ? { mode } : {};
  const rows = await db.collection('leaderboard').find(query).sort({ score: -1, playedAt: 1 }).toArray();

  const seen = new Set();
  const unique = [];
  for (const r of rows) {                      // rows are already best-first
    if (seen.has(r.playerId)) continue;
    seen.add(r.playerId);
    unique.push(r);
  }
  unique.sort((a, b) => (b.score - a.score) || (time(a.playedAt) - time(b.playedAt)));

  let myRank = null;
  const ranked = unique.map((e, i) => {
    const entry = {
      rank: i + 1, playerId: e.playerId, nickname: e.nickname || 'Player', score: e.score,
      mode: e.mode, rankIdx: e.rankIdx, rankName: e.rankName, playedAt: e.playedAt
    };
    if (playerId && e.playerId === playerId) myRank = entry;
    return entry;
  });
  return { mode: query.mode || 'all', entries: ranked.slice(0, limit), myRank, totalPlayers: ranked.length };
}

async function getPlayer(db, playerId) {
  const player = await db.collection('players').findOne({ playerId });
  const bests = await db.collection('leaderboard').find({ playerId }).toArray();
  const history = await db.collection('game_runs').find({ playerId }).sort({ playedAt: -1 }).limit(10).toArray();
  const games = await db.collection('game_runs').countDocuments({ playerId });
  const certificates = await db.collection('certificates').countDocuments({ playerId });
  return { player: player ? { playerId, name: player.name } : null, bests, history, games, certificates };
}

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

/** Stores the certificate record. Only allowed if this player really reached that score. */
async function recordCertificate(db, { playerId, name, rankIdx, score, mode }) {
  const min = RANKS[rankIdx].min;
  const reached = await db.collection('leaderboard').find({ playerId, score: { $gte: min } }).toArray();
  if (!reached.length) return { ok: false, status: 403, error: 'This score has not been recorded for this device.' };
  const player = await upsertPlayer(db, playerId, name);
  const issuedAt = new Date();
  await db.collection('certificates').updateOne(
    { playerId, rankIdx },
    {
      $set: { rankName: RANKS[rankIdx].name, score, mode, playerName: player.name, issuedAt },
      $setOnInsert: { createdAt: issuedAt }
    },
    { upsert: true }
  );
  return { ok: true, status: 201 };
}

async function getStats(db) {
  const top = async (mode) => {
    const r = await db.collection('leaderboard').find({ mode }).sort({ score: -1 }).limit(1).toArray();
    return r[0] ? r[0].score : 0;
  };
  return {
    totalPlayers: await db.collection('players').countDocuments(),
    totalRuns: await db.collection('game_runs').countDocuments(),
    totalCertificates: await db.collection('certificates').countDocuments(),
    bestNormal: await top('normal'),
    bestNoWalls: await top('nowalls')
  };
}

module.exports = {
  VALID_MODES, MODE_LABELS, RANKS, CERT_RANK_IDX, MAX_SCORE, MAX_NAME_LEN,
  rankIndexFor, sanitizeName, validPlayerId, validScore,
  upsertPlayer, submitScore, getLeaderboard, getPlayer, recordCertificate, getStats
};
