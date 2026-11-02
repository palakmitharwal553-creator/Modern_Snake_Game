/* test/verify.js
   Automated checks for the device-based player system (no network, no Express needed).
   Runs the real service code against the local JSON database in a temporary folder.
   Run with:  node test/verify.js  */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-test-'));
process.env.NS_LOCAL_DB_PATH = path.join(tmp, 'db.json');

const { LocalDb, ensureIndexes } = require('../db/mongo');
const svc = require('../lib/service');

let passed = 0;
let failed = 0;
function ok(cond, desc) {
  if (cond) { console.log('  PASS: ' + desc); passed++; }
  else { console.error('  FAIL: ' + desc); failed++; }
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log('--- Number Snake verification ---');
  const db = new LocalDb(process.env.NS_LOCAL_DB_PATH);
  await ensureIndexes(db);

  // Helpers and validation
  ok(svc.sanitizeName('  <b>Asha</b>   Rao ') === 'Asha Rao', 'name: tags removed, spaces collapsed');
  ok(svc.sanitizeName('<script>alert(1)</script>') === 'alert(1)', 'name: script tags stripped');
  ok(svc.sanitizeName('   ') === '' && svc.sanitizeName(5) === '', 'name: blank / non-string rejected');
  ok(svc.sanitizeName('x'.repeat(80)).length === 25, 'name: limited to 25 characters');
  ok(svc.sanitizeName('आशा शर्मा') === 'आशा शर्मा', 'name: Hindi names are kept');
  ok(svc.validPlayerId('p_abc123_xyz') && !svc.validPlayerId('a b') && !svc.validPlayerId('short') && !svc.validPlayerId(null), 'playerId format');
  ok(svc.validScore(0) && svc.validScore(120) && !svc.validScore(-1) && !svc.validScore(1.5) && !svc.validScore(501) && !svc.validScore('9'), 'score validation');
  ok([0, 9, 10, 24, 25, 49, 50, 79, 80, 119, 120].map(svc.rankIndexFor).join() === '0,0,1,1,2,2,3,3,4,4,5', 'rank thresholds');

  // A new device: name saved once, scores submitted
  const A = 'device_AAAAAAAA';
  const B = 'device_BBBBBBBB';
  const C = 'device_CCCCCCCC';

  let r = await svc.submitScore(db, { playerId: A, name: 'Asha', score: 30, mode: 'normal' });
  ok(r.rank === 1 && r.isNewBest, 'first score is rank 1 and a new best');
  r = await svc.submitScore(db, { playerId: A, name: 'Asha', score: 20, mode: 'normal' });
  ok(!r.isNewBest && r.bestScore === 30, 'a lower score does not replace the best');
  r = await svc.submitScore(db, { playerId: A, name: 'Asha', score: 55, mode: 'normal' });
  ok(r.isNewBest && r.bestScore === 55, 'a higher score replaces the best');

  await wait(5);
  await svc.submitScore(db, { playerId: B, name: 'Bala', score: 55, mode: 'normal' });
  r = await svc.submitScore(db, { playerId: C, name: 'Chitra', score: 70, mode: 'normal' });
  ok(r.rank === 1, 'highest score ranks 1');
  const lbN = await svc.getLeaderboard(db, { mode: 'normal', playerId: B });
  ok(lbN.entries.map(e => e.nickname).join() === 'Chitra,Asha,Bala', 'tie: the earlier score ranks higher');
  ok(lbN.myRank && lbN.myRank.rank === 3, 'own rank is reported');
  r = await svc.submitScore(db, { playerId: B, name: 'Bala', score: 40, mode: 'normal' });
  ok(r.rank === 3, 'rank after a non-best run is still correct (3)');

  // Modes are separate; overall shows each device once with its best
  await svc.submitScore(db, { playerId: A, name: 'Asha', score: 90, mode: 'nowalls' });
  const lbW = await svc.getLeaderboard(db, { mode: 'nowalls' });
  ok(lbW.entries.length === 1 && lbW.entries[0].score === 90, 'No walls board is separate');
  const lbAll = await svc.getLeaderboard(db, { mode: 'all' });
  ok(lbAll.entries.length === 3 && lbAll.entries[0].nickname === 'Asha' && lbAll.entries[0].score === 90, 'Overall: one row per device, best score first');
  ok(lbAll.entries.filter(e => e.playerId === A).length === 1, 'Overall: device appears once');
  ok(lbAll.totalPlayers === 3, 'total players counted by device');
  ok((await svc.getLeaderboard(db, { mode: 'bogus' })).mode === 'all', 'unknown mode falls back to overall');

  // Editing the name updates the leaderboard rows
  await svc.upsertPlayer(db, A, 'Asha R');
  const lbAfter = await svc.getLeaderboard(db, { mode: 'all' });
  ok(lbAfter.entries[0].nickname === 'Asha R', 'renamed device shows the new name on the leaderboard');
  const nrows = await db.collection('players').countDocuments({ playerId: A });
  ok(nrows === 1, 'renaming does not create a second player');

  // Player info
  const info = await svc.getPlayer(db, A);
  ok(info.player.name === 'Asha R' && info.games === 4 && info.bests.length === 2, 'player info: name, games and bests');
  ok((await svc.getPlayer(db, 'device_ZZZZZZZZ')).player === null, 'unknown device returns no player');

  // Certificates
  let c = await svc.recordCertificate(db, { playerId: A, name: 'Asha R', rankIdx: 3, score: 55, mode: 'normal' });
  ok(c.ok, 'certificate (50+) recorded when the score exists');
  c = await svc.recordCertificate(db, { playerId: A, name: 'Asha R', rankIdx: 3, score: 60, mode: 'normal' });
  ok(c.ok && (await db.collection('certificates').countDocuments({ playerId: A, rankIdx: 3 })) === 1, 'same milestone is stored once');
  c = await svc.recordCertificate(db, { playerId: A, name: 'Asha R', rankIdx: 4, score: 90, mode: 'nowalls' });
  ok(c.ok, 'certificate (80+) recorded');
  c = await svc.recordCertificate(db, { playerId: B, name: 'Bala', rankIdx: 4, score: 85, mode: 'normal' });
  ok(!c.ok && c.status === 403, 'certificate refused when the device never reached that score');
  ok((await svc.getPlayer(db, A)).certificates === 2, 'certificate count for the device');

  // Persistence: a new database object reads the same file
  const db2 = new LocalDb(process.env.NS_LOCAL_DB_PATH);
  const lbPersist = await svc.getLeaderboard(db2, { mode: 'all' });
  ok(lbPersist.entries.length === 3 && lbPersist.entries[0].nickname === 'Asha R', 'data persists in data/db.json');

  const stats = await svc.getStats(db);
  ok(stats.totalPlayers === 3 && stats.bestNormal === 70 && stats.bestNoWalls === 90, 'statistics');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
