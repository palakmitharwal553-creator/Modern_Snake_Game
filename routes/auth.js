/* routes/auth.js
   POST /api/register  — create a new account
   POST /api/login     — authenticate and start a session
   POST /api/logout    — destroy the session
   GET  /api/me        — return the current session user (or null)  */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { db } = require('../db/mongo');

const router = express.Router();

// ---------------------------------------------------------------------------
// Rate limiting — applied only to auth mutation endpoints, not to /api/me
// ---------------------------------------------------------------------------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // max 20 attempts per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_\- ]{2,30}$/;
const BCRYPT_ROUNDS = 12;

function validateEmail(v) {
  return typeof v === 'string' && EMAIL_RE.test(v.trim());
}
function validatePassword(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 128;
}
function validateUsername(v) {
  return typeof v === 'string' && USERNAME_RE.test(v.trim());
}

/** Strip all sensitive fields before sending the user object to the client. */
function safeUser(doc) {
  return {
    id: doc._id.toString(),
    username: doc.username,
    email: doc.email,
    bestScores: doc.bestScores || { normal: 0, nowalls: 0 },
    createdAt: doc.createdAt
  };
}

// ---------------------------------------------------------------------------
// POST /api/register
// ---------------------------------------------------------------------------
router.post('/register', authLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body || {};

    // --- Validate inputs ---
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!validateUsername(username)) {
      return res.status(400).json({
        error: 'Username must be 2–30 characters (letters, numbers, spaces, _ or -).'
      });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be 8–128 characters.' });
    }

    const normalEmail = email.trim().toLowerCase();

    // --- Hash password (never store plain text) ---
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // --- Insert user ---
    const now = new Date();
    const result = await db().collection('users').insertOne({
      email: normalEmail,
      username: username.trim(),
      passwordHash,
      bestScores: { normal: 0, nowalls: 0 },
      createdAt: now,
      updatedAt: now
    });

    const user = await db().collection('users').findOne({ _id: result.insertedId });

    // Start a session for the newly registered user
    req.session.userId = result.insertedId.toString();
    req.session.save((err) => {
      if (err) {
        console.error('[auth] Session save error after register:', err);
        return res.status(500).json({ error: 'Registration succeeded but session could not be started.' });
      }
      return res.status(201).json({ user: safeUser(user) });
    });
  } catch (err) {
    // Duplicate email (MongoDB unique index violation)
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }
    console.error('[auth] Register error:', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/login
// ---------------------------------------------------------------------------
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({ error: 'Password must be 8–128 characters.' });
    }

    const normalEmail = email.trim().toLowerCase();
    const user = await db().collection('users').findOne({ email: normalEmail });

    // Use constant-time compare to avoid timing attacks
    const validPassword = user ? await bcrypt.compare(password, user.passwordHash) : false;

    if (!user || !validPassword) {
      // Generic message — do not reveal which field was wrong
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Regenerate session id to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('[auth] Session regenerate error on login:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }
      req.session.userId = user._id.toString();
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[auth] Session save error on login:', saveErr);
          return res.status(500).json({ error: 'Login failed. Please try again.' });
        }
        return res.json({ user: safeUser(user) });
      });
    });
  } catch (err) {
    console.error('[auth] Login error:', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/logout
// ---------------------------------------------------------------------------
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('[auth] Logout error:', err);
      return res.status(500).json({ error: 'Logout failed.' });
    }
    res.clearCookie('connect.sid'); // default cookie name; matches server.js config
    return res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// GET /api/me  — return the current user from the session, or null
// ---------------------------------------------------------------------------
router.get('/me', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.json({ user: null });
    }
    const { ObjectId } = require('mongodb');
    const user = await db()
      .collection('users')
      .findOne({ _id: new ObjectId(req.session.userId) });

    if (!user) {
      // Session points to a deleted user — clear it
      req.session.destroy(() => {});
      return res.json({ user: null });
    }
    return res.json({ user: safeUser(user) });
  } catch (err) {
    console.error('[auth] /api/me error:', err.message);
    return res.status(500).json({ error: 'Could not retrieve session.' });
  }
});

module.exports = router;

