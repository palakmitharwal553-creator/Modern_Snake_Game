
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const {
  connect,
  close,
  isAtlasConnected,
  getClient
} = require('./db/mongo');

const authRoutes = require('./routes/auth');
const runRoutes = require('./routes/runs');
const certRoutes = require('./routes/certs');
const leaderboardRoutes = require('./routes/leaderboard');

const app = express();

const PORT = parseInt(process.env.PORT || '3000', 10);
const isProd = process.env.NODE_ENV === 'production';

async function start() {
  try {
    // Connect to the database
    await connect();

    // Require a secure session secret in production
    const sessionSecret =
      process.env.SESSION_SECRET ||
      (isProd ? null : 'number-snake-local-development-secret');

    if (!sessionSecret) {
      throw new Error(
        'SESSION_SECRET must be configured in production.'
      );
    }

    // Configure session storage
    let sessionStore;

    if (isAtlasConnected()) {
      sessionStore = MongoStore.create({
        client: getClient(),
        collectionName: 'sessions',
        ttl: 7 * 24 * 60 * 60
      });

      console.log(
        '[session] MongoDB session store active.'
      );
    } else {
      if (isProd) {
        throw new Error(
          'MongoDB Atlas must be connected in production.'
        );
      }

      console.warn(
        '[session] Using temporary local MemoryStore for development.'
      );
    }

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.use(
      session({
        name: 'ns_sid',
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        store: sessionStore,
        cookie: {
          httpOnly: true,
          secure: isProd,
          sameSite: 'lax',
          maxAge: 7 * 24 * 60 * 60 * 1000
        }
      })
    );

    // API routes
    app.use('/api/auth', authRoutes);
    app.use('/api/runs', runRoutes);
    app.use('/api/certs', certRoutes);
    app.use('/api/leaderboard', leaderboardRoutes);

    // Static frontend
    app.use(express.static(path.join(__dirname)));

    // Serve the game frontend for non-API routes
    app.get(/.*/, (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        return next();
      }

      res.sendFile(path.join(__dirname, 'index.html'));
    });

    // API 404 handler
    app.use('/api', (req, res) => {
      res.status(404).json({
        success: false,
        message: 'API endpoint not found.'
      });
    });

    // Error handler
    app.use((err, req, res, next) => {
      console.error('[server] Error:', err);

      res.status(err.status || 500).json({
        success: false,
        message: isProd
          ? 'Internal server error.'
          : err.message
      });
    });

    // Listen on Render's assigned port
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `[server] NUMBER SNAKE ready on port ${PORT}`
      );

      console.log(
        `[server] Database mode: ${
          isAtlasConnected()
            ? 'MongoDB Atlas'
            : 'Local development database'
        }`
      );
    });

    // Graceful shutdown
    const shutdown = async (signal) => {
      console.log(`[server] ${signal} received. Shutting down...`);

      server.close(async () => {
        try {
          await close();
          console.log('[server] Shutdown complete.');
          process.exit(0);
        } catch (error) {
          console.error('[server] Shutdown error:', error);
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    console.error('[server] Startup failed:', error);

    try {
      await close();
    } catch (closeError) {
      console.error('[server] Database close error:', closeError);
    }

    process.exit(1);
  }
}

start();
