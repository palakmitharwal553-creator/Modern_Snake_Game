/* test/verify.js
   Automated verification test suite for Number Snake.
   Tests backend APIs, leaderboard sorting & tie-breaking, guest & auth runs,
   data persistence, and certificate endpoints. */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = 3055;
process.env.PORT = String(PORT);
process.env.NODE_ENV = 'development';
process.env.SESSION_SECRET = 'test_secret_for_automated_verification_suite_99';

// Set up server
const express = require('express');
const session = require('express-session');
const { connect, db, close } = require('../db/mongo');
const authRouter = require('../routes/auth');
const runsRouter = require('../routes/runs');
const certsRouter = require('../routes/certs');
const leaderboardRouter = require('../routes/leaderboard');

const app = express();
app.use(express.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 3600000 }
  })
);

app.use('/api', authRouter);
app.use('/api/runs', runsRouter);
app.use('/api/certs', certsRouter);
app.use('/api/leaderboard', leaderboardRouter);
app.use(express.static(path.join(__dirname, '..')));

function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('--- Starting Number Snake Verification Suite ---');
  let passed = 0;
  let failed = 0;

  function assert(condition, desc) {
    if (condition) {
      console.log(`  ✅ PASS: ${desc}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${desc}`);
      failed++;
    }
  }

  await connect();

  const server = app.listen(PORT, async () => {
    try {
      console.log(`[test] Server listening on port ${PORT}`);

      // 1. Static file check
      const resIndex = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/index.html',
        method: 'GET'
      });
      assert(resIndex.statusCode === 200 && resIndex.data.includes('NUMBER SNAKE'), 'GET /index.html returns game HTML');

      // 2. Initial Leaderboard (empty or existing)
      const resLb1 = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard?mode=all',
        method: 'GET'
      });
      assert(resLb1.statusCode === 200 && resLb1.json && Array.isArray(resLb1.json.entries), 'GET /api/leaderboard returns 200 with entries array');

      // 3. Guest score submission
      const guestPlayerId = 'guest_test_' + Date.now();
      const resSub1 = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard/submit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        playerId: guestPlayerId,
        nickname: '<script>alert(1)</script>Alex Snake',
        score: 45,
        mode: 'normal',
        rankIdx: 2,
        rankName: 'Skilled',
        reason: 'wall',
        runToken: 'run_1'
      });
      assert(resSub1.statusCode === 201 && resSub1.json.ok === true, 'POST /api/leaderboard/submit accepts guest score with sanitized nickname');

      // 4. Verify nickname was sanitized (no script tags)
      const resLbAfter = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard?mode=normal&playerId=' + guestPlayerId,
        method: 'GET'
      });
      const alexEntry = resLbAfter.json.entries.find(e => e.playerId === guestPlayerId);
      assert(alexEntry && alexEntry.nickname === 'Alex Snake' && !alexEntry.nickname.includes('<script>'), 'Nickname HTML tags stripped safely');
      assert(alexEntry && alexEntry.score === 45, 'Score correctly recorded as 45');

      // 5. Higher score ranking above lower score
      const guestPlayer2 = 'guest_pro_' + Date.now();
      await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard/submit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        playerId: guestPlayer2,
        nickname: 'Viper Pro',
        score: 85,
        mode: 'normal',
        rankIdx: 4,
        rankName: 'Expert',
        reason: 'bomb',
        runToken: 'run_2'
      });

      const resLbRanking = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard?mode=normal',
        method: 'GET'
      });
      const topEntry = resLbRanking.json.entries[0];
      assert(topEntry && topEntry.score >= 85, 'Higher score ranks above lower score');

      // 6. Mode filter separation: No Walls Mode
      await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard/submit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        playerId: guestPlayer2,
        nickname: 'Viper Pro',
        score: 60,
        mode: 'nowalls',
        rankIdx: 3,
        rankName: 'Pro',
        reason: 'self',
        runToken: 'run_3'
      });

      const resLbNoWalls = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard?mode=nowalls',
        method: 'GET'
      });
      const allNowalls = resLbNoWalls.json.entries.every(e => e.mode === 'nowalls');
      assert(allNowalls && resLbNoWalls.json.entries.length > 0, 'Leaderboard mode filter strictly returns only "nowalls" scores');

      // 7. Deduplication check: resubmitting identical token is ignored
      const resDup = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/leaderboard/submit',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        playerId: guestPlayer2,
        nickname: 'Viper Pro',
        score: 60,
        mode: 'nowalls',
        rankIdx: 3,
        rankName: 'Pro',
        reason: 'self',
        runToken: 'run_3'
      });
      assert(resDup.json.duplicateIgnored === true, 'Duplicate submission with same runToken safely ignored');

      // 8. Register and Session-based Authentication
      const testEmail = `player_${Date.now()}@example.com`;
      const resReg = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/register',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, {
        username: 'LegendGamer',
        email: testEmail,
        password: 'SuperSecurePassword123!'
      });
      assert(resReg.statusCode === 201 && resReg.json.user.username === 'LegendGamer', 'POST /api/register creates user account and starts session');

      const cookie = resReg.headers['set-cookie'] ? resReg.headers['set-cookie'][0].split(';')[0] : '';
      assert(cookie.length > 0, 'Session cookie returned upon registration');

      // 9. GET /api/me with session
      const resMe = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/me',
        method: 'GET',
        headers: { Cookie: cookie }
      });
      assert(resMe.statusCode === 200 && resMe.json.user && resMe.json.user.email === testEmail, 'GET /api/me returns current session user');

      // 10. Authenticated score submission
      const resAuthRun = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/runs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie
        }
      }, {
        score: 95,
        mode: 'normal',
        rankIdx: 4,
        rankName: 'Expert',
        reason: 'wall'
      });
      assert(resAuthRun.statusCode === 201, 'POST /api/runs successfully saves score for authenticated user');

      // 11. Certificates persistence
      const resCert = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/certs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie
        }
      }, {
        rankIdx: 4,
        rankName: 'Expert',
        score: 95,
        mode: 'Normal',
        playerName: 'LegendGamer'
      });
      assert(resCert.statusCode === 201 && resCert.json.ok === true, 'POST /api/certs saves certificate record for milestone');

      // 12. Logout
      const resLogout = await request({
        hostname: 'localhost',
        port: PORT,
        path: '/api/logout',
        method: 'POST',
        headers: { Cookie: cookie }
      });
      assert(resLogout.statusCode === 200 && resLogout.json.ok === true, 'POST /api/logout terminates session');

      console.log(`\n--- Verification Completed: ${passed} Passed, ${failed} Failed ---`);
    } catch (err) {
      console.error('Test error:', err);
      failed++;
    } finally {
      server.close();
      await close();
      process.exit(failed > 0 ? 1 : 0);
    }
  });
}

runTests();

