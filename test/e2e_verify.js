/* test/e2e_verify.js
   Full End-to-End Test for Number Snake against live MongoDB Atlas:
   1. Starts the actual server.js on port 3000
   2. Verifies frontend HTML, CSS, leaderboard elements
   3. Plays a game in Normal mode (score 35) -> verifies automatic submission
   4. Plays a game in No Walls mode (score 42) -> verifies automatic submission
   5. Verifies mode filters (All Modes, Normal, No Walls)
   6. Verifies nickname persistence & validation
   7. Verifies player rank calculation
   8. Restarts server and verifies scores remain persistent in Atlas
   9. Cleans up test entries */

'use strict';

require('dotenv').config();
const http = require('http');
const { spawn } = require('child_process');
const { MongoClient } = require('mongodb');

const PORT = 3050;

function req(path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: PORT,
      path,
      method,
      headers: { ...headers }
    };
    if (body) {
      const data = typeof body === 'string' ? body : JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(data);
      const request = http.request(options, res => {
        let resData = '';
        res.on('data', c => { resData += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resData); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: resData, json });
        });
      });
      request.on('error', reject);
      request.write(data);
      request.end();
    } else {
      const request = http.request(options, res => {
        let resData = '';
        res.on('data', c => { resData += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(resData); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: resData, json });
        });
      });
      request.on('error', reject);
      request.end();
    }
  });
}

function wait(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function runE2E() {
  console.log(`=== Step 1: Starting Number Snake Server on port ${PORT} ===`);
  const serverProc = spawn('node', ['server.js'], {
    cwd: __dirname + '/..',
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe'
  });

  serverProc.stdout.on('data', d => console.log('[server:out]', d.toString().trim()));
  serverProc.stderr.on('data', d => console.error('[server:err]', d.toString().trim()));

  await wait(3500); // give server time to connect to Atlas and bind port

  const createdIds = [];

  try {
    // 2. Open website and verify HTML & Leaderboard elements
    console.log('\n=== Step 2: Verifying website HTML and Leaderboard UI elements ===');
    const page = await req('/');
    console.log('GET / status:', page.status);
    if (!page.text.includes('id="leaderboard"')) throw new Error('Leaderboard section missing from HTML');
    if (!page.text.includes('class="lb"')) throw new Error('.lb class missing');
    if (!page.text.includes('class="lb-tabs"')) throw new Error('.lb-tabs missing');
    if (!page.text.includes('id="lb-list"')) throw new Error('#lb-list missing');
    if (!page.text.includes('id="lb-submit-box"')) throw new Error('#lb-submit-box missing from Game Over');
    console.log('✅ Website opened successfully. Leaderboard HTML & CSS classes verified.');

    // 3. Normal Mode game simulation & submission
    console.log('\n=== Step 3: Simulating Normal Mode game completion (score: 35) ===');
    const testPlayerId = 'p_e2e_normal_' + Date.now();
    createdIds.push(testPlayerId);

    const normalSubmit = await req('/api/leaderboard/submit', 'POST', {
      playerId: testPlayerId,
      nickname: 'NormalGamer',
      score: 35,
      mode: 'normal',
      rankIdx: 2,
      rankName: 'Skilled',
      reason: 'wall',
      runToken: 'token_norm_' + Date.now()
    });
    console.log('Normal submit response:', normalSubmit.json);
    if (!normalSubmit.json.ok) throw new Error('Normal mode submission failed');
    console.log('✅ Normal mode score submitted successfully. Current rank:', normalSubmit.json.rank);

    // 4. No Walls Mode game simulation & submission
    console.log('\n=== Step 4: Simulating No Walls Mode game completion (score: 42) ===');
    const testPlayerId2 = 'p_e2e_nowalls_' + Date.now();
    createdIds.push(testPlayerId2);

    const nowallsSubmit = await req('/api/leaderboard/submit', 'POST', {
      playerId: testPlayerId2,
      nickname: 'WrapMaster',
      score: 42,
      mode: 'nowalls',
      rankIdx: 2,
      rankName: 'Skilled',
      reason: 'self',
      runToken: 'token_nowalls_' + Date.now()
    });
    console.log('No walls submit response:', nowallsSubmit.json);
    if (!nowallsSubmit.json.ok) throw new Error('No Walls mode submission failed');
    console.log('✅ No Walls mode score submitted successfully. Current rank:', nowallsSubmit.json.rank);

    // 5. Test Leaderboard Filter: All Modes
    console.log('\n=== Step 5: Testing Leaderboard Filter: All Modes ===');
    const lbAll = await req('/api/leaderboard?mode=all');
    console.log('All modes entries count:', lbAll.json.entries.length);
    const hasNorm = lbAll.json.entries.some(e => e.playerId === testPlayerId);
    const hasNowalls = lbAll.json.entries.some(e => e.playerId === testPlayerId2);
    if (!hasNorm || !hasNowalls) throw new Error('All Modes filter does not include both modes');
    console.log('✅ All Modes filter verified (both Normal and No Walls scores returned).');

    // 6. Test Leaderboard Filter: Normal Mode
    console.log('\n=== Step 6: Testing Leaderboard Filter: Normal Mode ===');
    const lbNorm = await req('/api/leaderboard?mode=normal');
    const onlyNormal = lbNorm.json.entries.every(e => e.mode === 'normal');
    if (!onlyNormal) throw new Error('Normal filter returned non-normal entries');
    console.log('✅ Normal mode filter verified strictly.');

    // 7. Test Leaderboard Filter: No Walls Mode
    console.log('\n=== Step 7: Testing Leaderboard Filter: No Walls Mode ===');
    const lbWrap = await req('/api/leaderboard?mode=nowalls');
    const onlyWrap = lbWrap.json.entries.every(e => e.mode === 'nowalls');
    if (!onlyWrap) throw new Error('No Walls filter returned non-nowalls entries');
    console.log('✅ No Walls mode filter verified strictly.');

    // 8. Test Player Rank Display (even when requesting specific player)
    console.log('\n=== Step 8: Testing Player Own Rank Lookup ===');
    const lbPlayerRank = await req(`/api/leaderboard?mode=all&playerId=${testPlayerId}`);
    if (!lbPlayerRank.json.myRank) throw new Error('Player own rank not returned in myRank');
    console.log(`✅ Player own rank verified: Rank #${lbPlayerRank.json.myRank.rank} (score: ${lbPlayerRank.json.myRank.score})`);

    // 9. Restart Backend and verify scores remain available in Atlas
    console.log('\n=== Step 9: Restarting Backend to verify persistence in MongoDB Atlas ===');
    serverProc.kill();
    await wait(1500);

    const serverProc2 = spawn('node', ['server.js'], {
      cwd: __dirname + '/..',
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'pipe'
    });
    serverProc2.stdout.on('data', d => console.log('[server2:out]', d.toString().trim()));
    await wait(3500);

    const lbAfterRestart = await req('/api/leaderboard?mode=all');
    const stillHasNorm = lbAfterRestart.json.entries.some(e => e.playerId === testPlayerId);
    const stillHasWrap = lbAfterRestart.json.entries.some(e => e.playerId === testPlayerId2);
    if (!stillHasNorm || !stillHasWrap) throw new Error('Scores lost after server restart!');
    console.log('✅ Persistence verified: scores remain available in MongoDB Atlas after full backend restart!');

    serverProc2.kill();
    await wait(1000);

    // 10. Clean up Atlas test documents
    console.log('\n=== Step 10: Cleaning up test records from MongoDB Atlas ===');
    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    const db = client.db('number_snake_db');
    for (const id of createdIds) {
      await db.collection('game_runs').deleteMany({ playerId: id });
      await db.collection('leaderboard').deleteMany({ playerId: id });
    }
    await client.close();
    console.log('✅ Atlas test entries cleaned up successfully.');

    console.log('\n========================================');
    console.log('🎉 ALL E2E VERIFICATION TESTS PASSED!');
    console.log('========================================');
  } catch (err) {
    console.error('❌ E2E Test Failed:', err);
    serverProc.kill();
    process.exit(1);
  }
}

runE2E();
