/* test/device_leaderboard.js
   Integration test for the device-based leaderboard. Needs a real MongoDB
   REPLICA SET (MongoDB Atlas always is one) because submissions use transactions.

   Run against a throw-away database, never your live one:
     MONGODB_URI="<uri>" MONGODB_DB=number_snake_test node test/device_leaderboard.js */

'use strict';

process.env.MONGODB_DB = process.env.MONGODB_DB || 'number_snake_test';
require('dotenv').config();

const crypto = require('crypto');
const { connect, db, close } = require('../db/mongo');
const app = require('../server');

if (process.env.MONGODB_DB === 'number_snake_db') {
  console.error('Refusing to run against the live database number_snake_db.');
  process.exit(1);
}

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

(async () => {
  await connect();
  for (const c of ['players', 'game_runs', 'certificates', 'leaderboard']) await db().collection(c).deleteMany({});
  const server = app.listen(0);
  const base = 'http://127.0.0.1:' + server.address().port + '/api/leaderboard';
  const api = async (method, path, body, device) => {
    const headers = { 'Content-Type': 'application/json' };
    if (device) headers['X-Device-Id'] = device;
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const newDevice = () => crypto.randomUUID();
  const game = () => crypto.randomUUID();

  console.log('Registration');
  const A = newDevice(), B = newDevice(), C = newDevice();
  let r = await api('GET', '/player', null, A);
  check('unknown device is reported as not registered', r.body.registered === false);
  r = await api('POST', '/player', { deviceId: A, displayName: '  <b>Alice</b>  ' });
  check('first visit creates a player (sanitized name)', r.status === 201 && r.body.player.displayName === 'Alice', r.body);
  r = await api('POST', '/player', { deviceId: A, displayName: 'Other' });
  check('second registration returns the same player (no duplicate, name kept)', r.status === 200 && r.body.created === false && r.body.player.displayName === 'Alice');
  check('only one player document for the device', (await db().collection('players').countDocuments({ deviceId: A })) === 1);
  r = await api('POST', '/player', { deviceId: 'not-a-uuid', displayName: 'X' });
  check('invalid deviceId rejected', r.status === 400);
  r = await api('POST', '/player', { deviceId: B, displayName: '   ' });
  check('empty display name rejected', r.status === 400);
  const [r1, r2] = await Promise.all([api('POST', '/player', { deviceId: C, displayName: 'Cara' }), api('POST', '/player', { deviceId: C, displayName: 'Cara' })]);
  check('two simultaneous registrations still make exactly one player', (await db().collection('players').countDocuments({ deviceId: C })) === 1 && [r1.status, r2.status].every((s) => s === 200 || s === 201));

  console.log('Name editing');
  r = await api('PUT', '/player/name', { deviceId: A, displayName: 'Alice Pro' });
  check('name can be edited', r.status === 200 && r.body.player.displayName === 'Alice Pro');
  r = await api('GET', '/player', null, A);
  check('edited name persists', r.body.player.displayName === 'Alice Pro');
  r = await api('PUT', '/player/name', { deviceId: newDevice(), displayName: 'Ghost' });
  check('renaming an unregistered device fails', r.status === 404);

  console.log('Scores across both modes -> one global best');
  const g1 = game();
  r = await api('POST', '/submit', { deviceId: A, gameId: g1, score: 30, mode: 'normal' });
  check('first game: entered the leaderboard at #1', r.status === 201 && r.body.rank === 1 && r.body.movement === 'entered' && r.body.isNewBest === true, r.body);
  r = await api('POST', '/submit', { deviceId: A, gameId: game(), score: 45, mode: 'nowalls' });
  check('No Walls 45 beats Normal 30 (best mode changes)', r.body.player.bestScore === 45 && r.body.player.bestMode === 'nowalls');
  r = await api('POST', '/submit', { deviceId: A, gameId: game(), score: 60, mode: 'normal' });
  check('Normal 60 becomes the global best', r.body.player.bestScore === 60 && r.body.player.bestMode === 'normal' && r.body.player.gamesPlayed === 3, r.body.player);
  const achieved = r.body.player.bestScoreAchievedAt;
  r = await api('POST', '/submit', { deviceId: A, gameId: game(), score: 20, mode: 'nowalls' });
  check('lower score never reduces the best, mode and time unchanged', r.body.player.bestScore === 60 && r.body.player.bestMode === 'normal' && r.body.player.bestScoreAchievedAt === achieved && r.body.isNewBest === false);
  check('latest score and games played update after every game', r.body.player.latestScore === 20 && r.body.player.gamesPlayed === 4);
  r = await api('POST', '/submit', { deviceId: A, gameId: game(), score: 60, mode: 'nowalls' });
  check('equal score is not a new best (earlier time kept)', r.body.isNewBest === false && r.body.player.bestMode === 'normal');

  console.log('Duplicate and concurrent submissions');
  const dup = game();
  r = await api('POST', '/submit', { deviceId: A, gameId: dup, score: 10, mode: 'normal' });
  const before = r.body.player.gamesPlayed;
  r = await api('POST', '/submit', { deviceId: A, gameId: dup, score: 99, mode: 'normal' });
  check('duplicate gameId is rejected by the unique index (no best change)', r.body.duplicate === true && r.body.player.bestScore === 60 && r.body.player.gamesPlayed === before, r.body);
  check('games played incremented exactly once for the duplicated game', (await db().collection('game_runs').countDocuments({ deviceId: A, gameId: dup })) === 1);
  const same = game();
  const burst = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/submit', { deviceId: B, gameId: same, score: 5, mode: 'normal' }).catch((e) => ({ status: 0, body: { error: String(e) } }))));
  // B is not registered yet -> register then repeat concurrently
  await api('POST', '/player', { deviceId: B, displayName: 'Bob' });
  const burst2 = await Promise.all(Array.from({ length: 8 }, () => api('POST', '/submit', { deviceId: B, gameId: same, score: 5, mode: 'normal' })));
  const pB = (await api('GET', '/player', null, B)).body.player;
  check('8 simultaneous identical submissions count once', pB.gamesPlayed === 1 && burst2.filter((x) => x.body.duplicate === false).length === 1, { games: pB.gamesPlayed, results: burst2.map((x) => x.status + ':' + x.body.duplicate) });
  const many = await Promise.all(Array.from({ length: 10 }, (_, i) => api('POST', '/submit', { deviceId: B, gameId: game(), score: i + 1, mode: i % 2 ? 'normal' : 'nowalls' })));
  const pB2 = (await api('GET', '/player', null, B)).body.player;
  check('10 simultaneous different games: all counted, best is the maximum', pB2.gamesPlayed === 11 && pB2.bestScore === 10 && many.every((x) => x.status === 201), { pB2, statuses: many.map((x) => x.status) });

  console.log('Validation');
  for (const [label, payload] of [
    ['negative score', { score: -1, mode: 'normal' }], ['fractional score', { score: 1.5, mode: 'normal' }],
    ['huge score', { score: 100000, mode: 'normal' }], ['string score', { score: '50', mode: 'normal' }],
    ['bad mode', { score: 5, mode: 'cheat' }], ['bad gameId', { score: 5, mode: 'normal', gameId: '../x' }]
  ]) {
    r = await api('POST', '/submit', { deviceId: A, gameId: game(), ...payload });
    check('rejects ' + label, r.status === 400, r.body);
  }
  r = await api('POST', '/submit', { deviceId: newDevice(), gameId: game(), score: 5, mode: 'normal' });
  check('submit from unregistered device is rejected', r.status === 404 && r.body.code === 'NOT_REGISTERED');

  console.log('Ranking, tie-breaks and rank movement');
  // current: A=60 (normal), B=10
  r = await api('POST', '/submit', { deviceId: C, gameId: game(), score: 60, mode: 'nowalls' });
  check('equal score reached LATER ranks below the earlier player', r.body.rank === 2 && r.body.movement === 'entered', r.body);
  r = await api('POST', '/submit', { deviceId: C, gameId: game(), score: 70, mode: 'normal' });
  check('rank moves up', r.body.rank === 1 && r.body.previousRank === 2 && r.body.movement === 'up' && r.body.change === 1, r.body);
  r = await api('POST', '/submit', { deviceId: A, gameId: game(), score: 5, mode: 'normal' });
  check('rank unchanged -> same', r.body.movement === 'same' && r.body.rank === 2, r.body);
  r = await api('POST', '/submit', { deviceId: B, gameId: game(), score: 65, mode: 'normal' });
  check('Bob jumps from #3 to #2', r.body.rank === 2 && r.body.previousRank === 3, r.body);
  r = await api('GET', '/player', null, A);
  check('Alice dropped to #3 (rank is computed on the server)', r.body.player.rank === 3);
  const D = newDevice(); await api('POST', '/player', { deviceId: D, displayName: 'Dan' });
  r = await api('GET', '/player', null, D);
  check('player with no score has no rank yet', r.body.player.rank === null);
  r = await api('POST', '/submit', { deviceId: D, gameId: game(), score: 0, mode: 'normal' });
  check('a score of 0 stays unranked but counts as a game', r.body.rank === null && r.body.movement === 'unranked' && r.body.player.gamesPlayed === 1);

  console.log('Leaderboard listing');
  r = await api('GET', '/', null, A);
  check('lists ranked players in order, one entry per device', r.body.entries.map((e) => e.displayName).join() === 'Cara,Bob,Alice Pro' && r.body.totalPlayers === 3, r.body.entries);
  check('device ids are never exposed', JSON.stringify(r.body).includes(A) === false && JSON.stringify(r.body).includes(B) === false);
  check('own entry is flagged isMe', r.body.entries.find((e) => e.isMe).displayName === 'Alice Pro');
  check('entry has rank, name, best score, best mode, achievement date', ['rank', 'displayName', 'bestScore', 'bestMode', 'bestScoreAchievedAt'].every((k) => r.body.entries[0][k] !== undefined && r.body.entries[0][k] !== null));
  // 60 players so that A falls outside the top 50
  const bulk = [];
  for (let i = 0; i < 55; i++) bulk.push({ deviceId: crypto.randomUUID(), displayName: 'Bot' + i, bestScore: 100 + i, bestMode: 'normal', bestScoreAchievedAt: new Date(), gamesPlayed: 1, createdAt: new Date() });
  await db().collection('players').insertMany(bulk);
  r = await api('GET', '/', null, A);
  check('top list is capped at 50', r.body.entries.length === 50);
  check('own rank is returned even outside the top 50', r.body.me && r.body.me.rank === 58 && r.body.entries.every((e) => !e.isMe), r.body.me);

  console.log('Certificates and legacy data');
  r = await fetch(base.replace('leaderboard', 'certs'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': A }, body: JSON.stringify({ rankIdx: 3, rankName: 'Pro', score: 60, mode: 'Normal', playerName: 'Alice' }) });
  check('certificate record saved for a device', r.status === 201);
  r = await fetch(base.replace('leaderboard', 'certs'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': A }, body: JSON.stringify({ rankIdx: 3, rankName: 'Pro', score: 61, mode: 'Normal', playerName: 'Alice' }) });
  check('same milestone does not create a second record', r.status === 201 && (await db().collection('certificates').countDocuments({ deviceId: A, rankIdx: 3 })) === 1);
  await db().collection('leaderboard').insertMany([
    { playerId: 'p_legacy1', nickname: 'Old', score: 40, mode: 'normal', playedAt: new Date('2026-10-01') },
    { playerId: 'p_legacy1', nickname: 'Old', score: 55, mode: 'nowalls', playedAt: new Date('2026-10-02') }
  ]);
  await db().collection('game_runs').insertOne({ playerId: 'p_legacy1', score: 55, mode: 'nowalls', playedAt: new Date('2026-10-02') });
  const L = newDevice();
  r = await api('POST', '/player', { deviceId: L, displayName: 'Oldie', legacyPlayerId: 'p_legacy1' });
  check('old leaderboard record is carried over (best of both modes)', r.body.player.bestScore === 55 && r.body.player.bestMode === 'nowalls' && r.body.player.gamesPlayed === 1, r.body.player);
  const L2 = newDevice();
  r = await api('POST', '/player', { deviceId: L2, displayName: 'Copycat', legacyPlayerId: 'p_legacy1' });
  check('a legacy record can only be claimed once', r.body.player.bestScore === 0, r.body.player);
  check('old collections and records are untouched', (await db().collection('leaderboard').countDocuments({ playerId: 'p_legacy1' })) === 2);

  console.log('Indexes');
  const idx = (await db().collection('game_runs').indexes()).find((i) => i.name === 'deviceId_gameId_unique');
  check('unique (deviceId, gameId) index exists on game_runs', !!idx && idx.unique === true);
  check('unique deviceId index exists on players', (await db().collection('players').indexes()).some((i) => i.name === 'deviceId_unique' && i.unique));

  server.close();
  await close();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });