'use strict';

const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = 3000;
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
const pool = new Pool({
  host: process.env.DB_HOST || 'easypost_postgres',
  port: Number.parseInt(process.env.DB_PORT, 10) || 5432,
  user: process.env.DB_USER || 'easypost',
  password: process.env.DB_PASSWORD || 'easypost123',
  database: 'EasyPost_USER',
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'easypost-admin-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_TIMEOUT_MS, httpOnly: true, sameSite: 'lax' },
}));
app.use(express.static(path.join(__dirname, 'public')));

async function ensureUserSchema() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(100),
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    UPDATE users
    SET is_admin = TRUE
    WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = TRUE)
  `);
}

function requireAdmin(req, res, next) {
  if (req.session?.admin?.isAdmin) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: '관리자 로그인이 필요합니다.' });
  }
  return res.redirect('/');
}

function normalizeText(value) {
  return String(value || '').trim();
}

app.post('/login', async (req, res) => {
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'ID와 비밀번호를 입력해주세요.' });

  try {
    const result = await pool.query(
      `UPDATE users
       SET last_login_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id FROM users
         WHERE username = $1
           AND password = crypt($2, password)
           AND is_active = TRUE
           AND is_admin = TRUE
       )
       RETURNING id, username, is_admin`,
      [username, password],
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ error: '관리자 계정 정보가 올바르지 않습니다.' });
    }
    req.session.admin = {
      id: result.rows[0].id,
      username: result.rows[0].username,
      isAdmin: result.rows[0].is_admin,
    };
    req.session.cookie.maxAge = SESSION_TIMEOUT_MS;
    return res.json({ success: true, redirect: '/admin' });
  } catch (err) {
    console.error('Admin login error:', err);
    return res.status(500).json({ error: '로그인 처리 중 오류가 발생했습니다.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/me', requireAdmin, (req, res) => {
  res.json({ id: req.session.admin.id, username: req.session.admin.username });
});

app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, username, email, phone_number, is_active, is_admin, last_login_at, created_at
       FROM users ORDER BY id`,
    );
    res.json({ users: result.rows });
  } catch (err) {
    console.error('Admin users read error:', err);
    res.status(500).json({ error: '사용자 목록을 불러오지 못했습니다.' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  const email = normalizeText(req.body.email) || null;
  const phoneNumber = normalizeText(req.body.phone_number) || null;
  const isActive = req.body.is_active !== false;
  const isAdmin = req.body.is_admin === true;
  if (!username || !password) return res.status(400).json({ error: '사용자 ID와 비밀번호는 필수입니다.' });

  try {
    const result = await pool.query(
      `INSERT INTO users (username, password, email, phone_number, is_active, is_admin)
       VALUES ($1, crypt($2, gen_salt('bf')), $3, $4, $5, $6)
       RETURNING id, username, email, phone_number, is_active, is_admin, last_login_at, created_at`,
      [username, password, email, phoneNumber, isActive, isAdmin],
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '이미 등록된 사용자 ID입니다.' });
    console.error('Admin user create error:', err);
    res.status(500).json({ error: '사용자를 추가하지 못했습니다.' });
  }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const username = normalizeText(req.body.username);
  const password = String(req.body.password || '');
  const email = normalizeText(req.body.email) || null;
  const phoneNumber = normalizeText(req.body.phone_number) || null;
  const isActive = req.body.is_active !== false;
  const isAdmin = req.body.is_admin === true;
  if (!Number.isInteger(id) || !username) return res.status(400).json({ error: '사용자 정보가 올바르지 않습니다.' });
  if (id === req.session.admin.id && (!isActive || !isAdmin)) {
    return res.status(400).json({ error: '현재 로그인한 관리자 권한 또는 활성 상태는 해제할 수 없습니다.' });
  }

  try {
    const result = await pool.query(
      `UPDATE users
       SET password = CASE WHEN $2 = '' THEN password ELSE crypt($2, gen_salt('bf')) END,
           email = $3,
           phone_number = $4,
           is_active = $5,
           is_admin = $6
       WHERE id = $1
       RETURNING id, username, email, phone_number, is_active, is_admin, last_login_at, created_at`,
      [id, password, email, phoneNumber, isActive, isAdmin],
    );
    if (result.rows.length === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    return res.json({ user: result.rows[0] });
  } catch (err) {
    console.error('Admin user update error:', err);
    return res.status(500).json({ error: '사용자 정보를 수정하지 못했습니다.' });
  }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: '사용자 번호가 올바르지 않습니다.' });
  if (id === req.session.admin.id) return res.status(400).json({ error: '현재 로그인한 사용자는 삭제할 수 없습니다.' });

  try {
    const target = await pool.query('SELECT is_admin FROM users WHERE id = $1', [id]);
    if (target.rows.length === 0) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
    if (target.rows[0].is_admin) {
      const admins = await pool.query('SELECT count(*)::int AS count FROM users WHERE is_admin = TRUE AND is_active = TRUE');
      if (admins.rows[0].count <= 1) return res.status(400).json({ error: '마지막 관리자는 삭제할 수 없습니다.' });
    }
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return res.json({ success: true });
  } catch (err) {
    console.error('Admin user delete error:', err);
    return res.status(500).json({ error: '사용자를 삭제하지 못했습니다.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

ensureUserSchema()
  .then(() => app.listen(PORT, () => console.log(`EasyPost admin running on port ${PORT}`)))
  .catch(err => {
    console.error('Admin initialization error:', err);
    process.exitCode = 1;
  });
