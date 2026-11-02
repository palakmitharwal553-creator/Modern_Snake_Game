/* server.js
   Express entry point for Number Snake.
   - Serves the static game files (index.html, style.css, script.js).
   - Mounts /api/leaderboard (device-based players, scores, ranks) and /api/certs.
   - MongoDB Atlas is required: the server refuses to start without it.
   There are no accounts, sessions or cookies; players are identified by the
   Device ID their browser generates. */

'use strict';

require('dotenv').config();

const express = require('express');
const path = require('path');

const { connect, close } = require('./db/mongo');

const leaderboardRouter = require('./routes/leaderboard');
const certsRouter = require('./routes/certs');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

// Behind a hosting proxy (Render, Railway, Netlify functions...) the real client IP
// comes from X-Forwarded-For. Rate limiting needs this to work per visitor.
if (isProd || process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '16kb' }));

// Only the three game files are public. Source, tests and config are never served.
const PUBLIC_FILES = ['index.html', 'style.css', 'script.js'];
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
PUBLIC_FILES.forEach((file) => {
  app.get('/' + file, (req, res) => res.sendFile(path.join(__dirname, file)));
});

// API routes
app.use('/api/leaderboard', leaderboardRouter);
app.use('/api/certs', certsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found' }));

// Anything else: the single-page game
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Malformed JSON and other errors
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  console.error('[server] Internal error:', err && err.message);
  res.status(500).json({ error: 'Internal server error.' });
});

async function start() {
  try {
    await connect();   // throws if MongoDB Atlas is unreachable: no silent fallback
  } catch (err) {
    console.error('[server] Cannot start: ' + err.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log('[server] NUMBER SNAKE ready at http://localhost:' + PORT);
    console.log('[server] Database: MongoDB Atlas (' + (process.env.MONGODB_DB || 'number_snake_db') + ')');
  });
}

process.on('SIGINT', async () => { await close(); process.exit(0); });
process.on('SIGTERM', async () => { await close(); process.exit(0); });

if (require.main === module) {
  start();
}

module.exports = app;