/* server.js
   Express entry point for Number Snake.
   - Serves the game files (index.html, style.css, script.js) and nothing else.
   - Mounts /api/player, /api/leaderboard and /api/certs.
   - No sign-in: every device is one player (random id + name kept in the browser). */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const { connect, close, isAtlasConnected } = require('./db/mongo');

const playerRouter = require('./routes/player');
const certsRouter = require('./routes/certs');
const leaderboardRouter = require('./routes/leaderboard');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

if (process.env.TRUST_PROXY) app.set('trust proxy', 1);   // set when running behind a proxy (Render, Nginx...)
app.disable('x-powered-by');

app.use(cors());   // lets the mobile app (different origin) call the API
app.use(express.json({ limit: '8kb' }));

// Open /api/health to check where data is really being stored ("atlas" = permanent, "local" = temporary file)
app.get('/api/health', (req, res) => res.json({ ok: true, dbMode: isAtlasConnected() ? 'atlas' : 'local' }));

// Only these files are public. (Serving the whole folder would expose .env, server.js and data/db.json.)
const PUBLIC_FILES = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/script.js': 'script.js' };
app.get(Object.keys(PUBLIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, PUBLIC_FILES[req.path]));
});

app.use('/api/player', playerRouter);
app.use('/api/certs', certsRouter);
app.use('/api/leaderboard', leaderboardRouter);

app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error('[server] Internal error:', err && err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

function listen(port, triesLeft) {
  const server = app.listen(port, () => {
    console.log('[server] NUMBER SNAKE ready at http://localhost:' + port);
    console.log('[server] Database mode: ' + (isAtlasConnected() ? 'MongoDB Atlas (number_snake_db)' : 'Persistent local DB (data/db.json)'));
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.warn('[server] Port ' + port + ' is in use, trying ' + (port + 1) + '...');
      listen(port + 1, triesLeft - 1);
    } else {
      console.error('[server] Server error:', err.message);
      process.exit(1);
    }
  });
}

async function start() {
  try {
    await connect();
    listen(PORT, 10);
  } catch (err) {
    console.error('[server] Boot error:', err.message);
    process.exit(1);
  }
}

async function shutdown() {
  console.log('\n[server] Shutting down...');
  try { await close(); } catch (e) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (require.main === module) start();

module.exports = { app, start };