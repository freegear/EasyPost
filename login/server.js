const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = 3000;
const FLOWISE_URL = process.env.FLOWISE_URL || 'http://localhost:3991';
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config.json');

const pool = new Pool({
  host: process.env.DB_HOST || 'easypost_postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'easypost',
  password: process.env.DB_PASSWORD || 'easypost123',
  database: 'EasyPost_USER',
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'easypost-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(express.static(path.join(__dirname, 'public')));

const HTML_DIR = path.join(__dirname, 'html');

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.redirect('/');
}

function normalizeConfig(config) {
  const cards = Array.isArray(config.cards) ? config.cards : [];
  return {
    cards: cards.slice(0, 12).map((card, idx) => ({
      id: Number.isInteger(card.id) ? card.id : idx + 1,
      active: card.active !== false,
    })),
  };
}

app.use('/css', express.static(path.join(__dirname, 'css')));

app.get('/dashboard', requireLogin, (req, res) => {
  res.sendFile(path.join(HTML_DIR, 'index.html'));
});

app.use('/dashboard', requireLogin, express.static(HTML_DIR));

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'ID와 비밀번호를 입력해주세요.' });
  }

  try {
    const result = await pool.query(
      `SELECT id, username FROM users
       WHERE username = $1
         AND password = crypt($2, password)
         AND is_active = true`,
      [username, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    req.session.user = { id: result.rows[0].id, username: result.rows[0].username };
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ username: req.session.user.username, id: req.session.user.id });
});

app.get('/api/config', requireLogin, async (req, res) => {
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    res.json(normalizeConfig(JSON.parse(raw)));
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ cards: [] });
    console.error('Config read error:', err);
    res.status(500).json({ error: '설정을 불러오지 못했습니다.' });
  }
});

app.post('/api/config', requireLogin, async (req, res) => {
  const config = normalizeConfig(req.body);
  const payload = {
    ...config,
    updatedAt: new Date().toISOString(),
  };

  try {
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    res.json({ success: true, config: payload });
  } catch (err) {
    console.error('Config write error:', err);
    res.status(500).json({ error: '설정을 저장하지 못했습니다.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Login server running on port ${PORT}`));
