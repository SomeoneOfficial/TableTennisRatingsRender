const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const app = express();
const ROOT_DIR = __dirname;
const PORT = Number(process.env.PORT || 10000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PRODUCTION = NODE_ENV === 'production';
const DATABASE_URL = process.env.DATABASE_URL || '';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
const SESSION_COOKIE = 'rankmaster_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const MAX_SAVE_BYTES = 2 * 1024 * 1024;
const CLOUD_ENABLED = Boolean(DATABASE_URL);

const pool = CLOUD_ENABLED
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: /sslmode=require/i.test(DATABASE_URL)
        ? { rejectUnauthorized: false }
        : undefined
    })
  : null;

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function parseCookies(headerValue) {
  const out = {};
  if (!headerValue) return out;
  headerValue.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(`${SESSION_SECRET}:${token}`)
    .digest('hex');
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (IS_PRODUCTION) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function asIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

function formatSaveRow(row) {
  if (!row) {
    return {
      save: null,
      version: 0,
      updatedAt: null,
      clientUpdatedAt: null
    };
  }
  return {
    save: row.data,
    version: Number(row.version) || 0,
    updatedAt: asIso(row.updated_at),
    clientUpdatedAt: asIso(row.client_updated_at)
  };
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_saves (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      client_updated_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
    ON user_sessions (user_id);
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
    ON user_sessions (expires_at);
  `);
}

async function deleteSessionByToken(token) {
  if (!pool || !token) return;
  await pool.query(
    'DELETE FROM user_sessions WHERE token_hash = $1',
    [hashToken(token)]
  );
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `
      INSERT INTO user_sessions (user_id, token_hash, expires_at)
      VALUES ($1, $2, $3)
    `,
    [userId, hashToken(token), expiresAt]
  );
  return token;
}

async function getSessionUser(req) {
  if (!pool) return null;
  const cookies = parseCookies(req.headers.cookie || '');
  const rawToken = cookies[SESSION_COOKIE];
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const result = await pool.query(
    `
      SELECT
        s.id AS session_id,
        s.expires_at,
        s.last_seen_at,
        u.id AS user_id,
        u.email
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
      LIMIT 1
    `,
    [tokenHash]
  );
  if (!result.rowCount) return null;
  const row = result.rows[0];
  const expiresAt = new Date(row.expires_at);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    await deleteSessionByToken(rawToken);
    return null;
  }
  const lastSeenAt = new Date(row.last_seen_at);
  if (!Number.isNaN(lastSeenAt.getTime()) && Date.now() - lastSeenAt.getTime() > 1000 * 60 * 30) {
    pool.query(
      'UPDATE user_sessions SET last_seen_at = NOW() WHERE id = $1',
      [row.session_id]
    ).catch(() => {});
  }
  return {
    id: Number(row.user_id),
    email: row.email,
    sessionId: Number(row.session_id),
    sessionToken: rawToken
  };
}

async function refreshSessionLifetime(user) {
  if (!pool || !user?.sessionId) return;
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    `
      UPDATE user_sessions
      SET
        last_seen_at = NOW(),
        expires_at = $2
      WHERE id = $1
    `,
    [user.sessionId, expiresAt]
  );
}

async function requireAuth(req, res, next) {
  if (!pool) {
    return res.status(503).json({
      error: 'Cloud sync is not configured on this server yet.'
    });
  }
  try {
    const user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: 'You need to sign in first.' });
    }
    await refreshSessionLifetime(user);
    setSessionCookie(res, user.sessionToken);
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudEnabled: CLOUD_ENABLED
  });
});

app.get('/api/auth/session', async (req, res, next) => {
  try {
    if (!pool) {
      return res.json({
        cloudEnabled: false,
        authenticated: false
      });
    }
    const user = await getSessionUser(req);
    if (user) {
      await refreshSessionLifetime(user);
      setSessionCookie(res, user.sessionToken);
    }
    res.json({
      cloudEnabled: true,
      authenticated: Boolean(user),
      email: user?.email || null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/register', async (req, res, next) => {
  if (!pool) {
    return res.status(503).json({
      error: 'Cloud sync is not configured on this server yet.'
    });
  }
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!validateEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (!validatePassword(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters.'
      });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      `
        INSERT INTO users (email, password_hash)
        VALUES ($1, $2)
        RETURNING id, email
      `,
      [email, passwordHash]
    );
    const user = result.rows[0];
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    res.status(201).json({
      authenticated: true,
      email: user.email
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'That email already has an account. Try logging in instead.'
      });
    }
    next(error);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  if (!pool) {
    return res.status(503).json({
      error: 'Cloud sync is not configured on this server yet.'
    });
  }
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!validateEmail(email) || typeof password !== 'string') {
      return res.status(400).json({
        error: 'Enter your email and password.'
      });
    }
    const result = await pool.query(
      `
        SELECT id, email, password_hash
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
      [email]
    );
    if (!result.rowCount) {
      return res.status(401).json({
        error: 'Email or password did not match.'
      });
    }
    const user = result.rows[0];
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) {
      return res.status(401).json({
        error: 'Email or password did not match.'
      });
    }
    const token = await createSession(user.id);
    setSessionCookie(res, token);
    res.json({
      authenticated: true,
      email: user.email
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', async (req, res, next) => {
  try {
    const cookies = parseCookies(req.headers.cookie || '');
    const rawToken = cookies[SESSION_COOKIE];
    if (rawToken) {
      await deleteSessionByToken(rawToken);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/save', requireAuth, async (req, res, next) => {
  try {
    const result = await pool.query(
      `
        SELECT data, version, updated_at, client_updated_at
        FROM user_saves
        WHERE user_id = $1
      `,
      [req.user.id]
    );
    res.json(formatSaveRow(result.rows[0]));
  } catch (error) {
    next(error);
  }
});

app.put('/api/save', requireAuth, async (req, res, next) => {
  const nextState = req.body?.state;
  const force = Boolean(req.body?.force);
  const baseVersion =
    typeof req.body?.baseVersion === 'number' && Number.isFinite(req.body.baseVersion)
      ? Math.floor(req.body.baseVersion)
      : null;
  const clientUpdatedAt = asIso(req.body?.clientUpdatedAt) || new Date().toISOString();

  if (!nextState || typeof nextState !== 'object' || Array.isArray(nextState)) {
    return res.status(400).json({ error: 'A valid state payload is required.' });
  }

  const encodedState = JSON.stringify(nextState);
  if (Buffer.byteLength(encodedState, 'utf8') > MAX_SAVE_BYTES) {
    return res.status(413).json({
      error: 'Save file is too large for cloud sync.'
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `
        SELECT data, version, updated_at, client_updated_at
        FROM user_saves
        WHERE user_id = $1
        FOR UPDATE
      `,
      [req.user.id]
    );

    if (!existing.rowCount) {
      const inserted = await client.query(
        `
          INSERT INTO user_saves (user_id, data, version, client_updated_at)
          VALUES ($1, $2::jsonb, 1, $3::timestamptz)
          RETURNING data, version, updated_at, client_updated_at
        `,
        [req.user.id, encodedState, clientUpdatedAt]
      );
      await client.query('COMMIT');
      return res.json(formatSaveRow(inserted.rows[0]));
    }

    const current = existing.rows[0];
    const currentVersion = Number(current.version) || 0;
    if (!force && baseVersion !== null && baseVersion !== currentVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Cloud save conflict detected.',
        current: formatSaveRow(current)
      });
    }

    const updated = await client.query(
      `
        UPDATE user_saves
        SET
          data = $2::jsonb,
          version = $3,
          updated_at = NOW(),
          client_updated_at = $4::timestamptz
        WHERE user_id = $1
        RETURNING data, version, updated_at, client_updated_at
      `,
      [req.user.id, encodedState, currentVersion + 1, clientUpdatedAt]
    );
    await client.query('COMMIT');
    res.json(formatSaveRow(updated.rows[0]));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    next(error);
  } finally {
    client.release();
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

app.use(express.static(ROOT_DIR, { index: false }));

app.get('*', (req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({
    error: 'Something went wrong on the server.'
  });
});

async function start() {
  try {
    await initDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(
        `RankMaster Pro server listening on http://0.0.0.0:${PORT} (${CLOUD_ENABLED ? 'cloud enabled' : 'cloud disabled'})`
      );
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();
