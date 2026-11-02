/* server.js
   Express entry point for Number Snake.
   - Serves static game files (index.html, style.css, script.js).
   - Mounts /api/auth, /api/runs, /api/certs, /api/leaderboard.
   - Manages sessions with connect-mongo when Atlas is active. */

'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const { connect, close, isAtlasConnected, getClient } = require('./db/mongo');

const authRouter = require('./routes/auth');
const runsRouter = require('./routes/runs');
const certsRouter = require('./routes/certs');
const leaderboardRouter = require('./routes/leaderboard');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

// Body parsing
app.use(express.json({ limit: '32kb' }));

// ---------------------------------------------------------------------------
// Startup & Middleware Initialization
// ---------------------------------------------------------------------------
async function start() {
  try {
    // 1. Establish database connection (Atlas with resilient fallback)
    await connect();

    // 2. Configure session store
    let sessionStore;
    if (isAtlasConnected() && getClient()) {
      sessionStore = MongoStore.create({
        client: getClient(),
        dbName: 'number_snake_db',
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60,
        autoRemove: 'native'
      });
      console.log('[session] connect-mongo session store active in collection "sessions".');
    } else {
      console.log('[session] Using local session store (Atlas not connected).');
    }

    const sessionSecret = process.env.SESSION_SECRET || 'number_snake_default_dev_secret_key_84920';

    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        store: sessionStore, // undefined falls back to MemoryStore cleanly
        cookie: {
          httpOnly: true,
          sameSite: 'lax',
          secure: isProd,
          maxAge: 7 * 24 * 60 * 60 * 1000
        },
        name: 'ns_sid'
      })
    );

    // 3. API Routes
    app.use('/api', authRouter);
    app.use('/api/runs', runsRouter);
    app.use('/api/certs', certsRouter);
    app.use('/api/leaderboard', leaderboardRouter);

    // 4. Static assets
    app.use(express.static(path.join(__dirname)));

    // Fallback: any non-API request returns index.html
    app.get('*', (req, res) => {
      if (!req.path.startsWith('/api')) {
        res.sendFile(path.join(__dirname, 'index.html'));
      } else {
        res.status(404).json({ error: 'Endpoint not found' });
      }
    });

    // Error handler
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, _next) => {
      console.error('[server] Internal error:', err.message);
      res.status(500).json({ error: 'Internal server error.' });
    });

    // Listen with automatic fallback if primary port is in use
    const server = app.listen(PORT, () => {
      console.log(`[server] NUMBER SNAKE ready at http://localhost:${PORT}`);
      console.log(`[server] Database mode: ${isAtlasConnected() ? 'MongoDB Atlas (number_snake_db)' : 'Persistent Local DB (data/db.json)'}`);
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        const altPort = PORT === 3000 ? 3001 : PORT + 1;
        console.warn(`[server] Port ${PORT} in use, automatically switching to http://localhost:${altPort}`);
        app.listen(altPort, () => {
          console.log(`[server] NUMBER SNAKE ready at http://localhost:${altPort}`);
          console.log(`[server] Database mode: ${isAtlasConnected() ? 'MongoDB Atlas (number_snake_db)' : 'Persistent Local DB (data/db.json)'}`);
        });
      } else {
        console.error('[server] Server error:', err.message);
      }
    });
  } catch (err) {
    console.error('[server] Boot error:', err.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n[server] Shutting down gracefully...');
  await close();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await close();
  process.exit(0);
});

start();
