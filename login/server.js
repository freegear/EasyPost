const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');
const { createPostingQueue } = require('./lib/postingQueue');

const app = express();
const PORT = 3000;
const FLOWISE_URL = process.env.FLOWISE_URL || 'http://localhost:3991';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const POST_COUNT = 12;
const SCHEDULER_TIMEZONE = 'Asia/Seoul';
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
let postingQueue;

const pool = new Pool({
  host: process.env.DB_HOST || 'easypost_postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'easypost',
  password: process.env.DB_PASSWORD || 'easypost123',
  database: 'EasyPost_USER',
});

function getPostingQueue() {
  if (!postingQueue) postingQueue = createPostingQueue();
  return postingQueue;
}

app.use(express.json({ limit: '500mb' }));
app.use(express.urlencoded({ extended: true, limit: '500mb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'easypost-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: SESSION_TIMEOUT_MS },
}));
app.use(express.static(path.join(__dirname, 'public')));

const HTML_DIR = path.join(__dirname, 'html');

function getSessionRemainingMs(req) {
  if (!req.session?.user || !req.session.lastActivityAt) return 0;
  return Math.max(0, SESSION_TIMEOUT_MS - (Date.now() - req.session.lastActivityAt));
}

function requireLogin(req, res, next) {
  if (getSessionRemainingMs(req) > 0) return next();
  if (req.session?.user) req.session.destroy(() => {});
  if (req.path.startsWith('/api/') || req.originalUrl.startsWith('/api/')) {
    return res.status(401).json({ error: '재로그인이 필요합니다.', loginRequired: true });
  }
  res.redirect('/');
}

// ── API Key 관리 ──────────────────────────────────────────────────────────────

function getApiKeysPath() {
  return path.join(DATA_DIR, 'apikeys.json');
}

async function getApiKeyMap() {
  try {
    const raw = await fs.readFile(getApiKeysPath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveApiKeyMap(map) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(getApiKeysPath(), JSON.stringify(map, null, 2) + '\n', 'utf8');
}

async function findUserByApiKey(key) {
  const map = await getApiKeyMap();
  return map[String(key)] || null;
}

async function getUserApiKey(username) {
  const map = await getApiKeyMap();
  for (const [k, u] of Object.entries(map)) {
    if (u === username) return k;
  }
  return null;
}

async function generateApiKey(username) {
  const map = await getApiKeyMap();
  // 기존 키 삭제
  for (const [k, u] of Object.entries(map)) {
    if (u === username) delete map[k];
  }
  const key = crypto.randomBytes(32).toString('hex');
  map[key] = username;
  await saveApiKeyMap(map);
  return key;
}

// 세션 OR API Key 모두 허용하는 미들웨어
async function requireApiKeyOrLogin(req, res, next) {
  if (getSessionRemainingMs(req) > 0) return next();
  if (req.session?.user) req.session.destroy(() => {});

  const key = req.headers['x-api-key'];
  if (key) {
    const username = await findUserByApiKey(key);
    if (username) {
      req.apiUser = { username, id: username };
      return next();
    }
    return res.status(401).json({ error: '유효하지 않은 API Key입니다.' });
  }

  res.status(401).json({ error: '인증이 필요합니다. 로그인하거나 X-Api-Key 헤더를 사용하세요.' });
}

// req.session.user 또는 req.apiUser를 반환하는 헬퍼
function getReqUser(req) {
  return req.session.user || req.apiUser;
}

function getSeoulScheduleParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SCHEDULER_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = type => parts.find(part => part.type === type)?.value || '';
  const hour = Number.parseInt(value('hour'), 10) % 24;
  const minute = Number.parseInt(value('minute'), 10);
  return {
    weekday: value('weekday').toLowerCase(),
    hour,
    minute,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

function normalizeScheduleTime(value) {
  const match = String(value || '').trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return '';
  let hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  const ampm = String(match[3] || '').toUpperCase();
  if (minute < 0 || minute > 59) return '';
  if (ampm) {
    if (hour < 1 || hour > 12) return '';
    if (ampm === 'AM') hour %= 12;
    else hour = (hour % 12) + 12;
  } else if (hour < 0 || hour > 23) {
    return '';
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeConfig(config) {
  const postCards = Array.isArray(config.postCards)
    ? config.postCards
    : Array.isArray(config.cards)
      ? config.cards
      : [];
  const slots = Array.isArray(config.slots) ? config.slots : [];
  return {
    postCards: postCards.slice(0, POST_COUNT).map((card, idx) => ({
      id: Number.isInteger(card.id) ? card.id : idx + 1,
      active: card.active !== false,
    })),
    slots: slots.slice(0, 4).map((slot, idx) => ({
      id: Number.isInteger(slot.id) ? slot.id : idx + 1,
      name: String(slot.name || `게시 작업 슬롯 #${idx + 1}`),
      active: slot.active !== false,
      naverId: String(slot.naverId || ''),
      naverPw: String(slot.naverPw || ''),
      username: String(slot.username || ''),
      cafeUrl: String(slot.cafeUrl || ''),
      boardName: String(slot.boardName || ''),
      postId: Number.parseInt(slot.postId, 10) || 1,
      postTitle: String(slot.postTitle || ''),
      mode: String(slot.mode || '순차적'),
      scheduleType: slot.scheduleType === 'weekly' ? 'weekly' : 'daily',
      weekdays: Array.isArray(slot.weekdays)
        ? slot.weekdays.filter(day => ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day))
        : [],
      time: String(slot.time || ''),
    })),
  };
}

function getActivePostIds(config) {
  return config.postCards
    .filter(card => card.active !== false)
    .map(card => card.id)
    .filter(id => Number.isInteger(id) && id >= 1 && id <= POST_COUNT)
    .sort((a, b) => a - b);
}

function selectPostId(config, slot, randomIndex = null) {
  const activePostIds = getActivePostIds(config);
  if (activePostIds.length === 0) throw new Error('활성화된 게시글이 없습니다.');

  if (slot.mode === '랜덤') {
    const index = randomIndex === null ? crypto.randomInt(activePostIds.length) : randomIndex;
    return activePostIds[index];
  }

  const postId = Number.parseInt(slot.postId, 10) || 1;
  if (!activePostIds.includes(postId)) {
    throw new Error(`선택된 콘텐츠 Post #${postId}가 비활성화 상태입니다.`);
  }
  return postId;
}

function getNextSequentialPostId(config, postedPostId) {
  const activePostIds = getActivePostIds(config);
  if (activePostIds.length === 0) return 1;
  return activePostIds.find(postId => postId > postedPostId) || activePostIds[0];
}

function defaultConfig() {
  return {
    postCards: Array.from({ length: POST_COUNT }, (_, idx) => ({
      id: idx + 1,
      active: false,
    })),
    slots: [],
  };
}

function userKey(user) {
  const base = user && (user.username || user.id);
  return String(base || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getUserDir(user) {
  return path.join(DATA_DIR, userKey(user));
}

function getConfigPath(user) {
  return path.join(getUserDir(user), 'config.json');
}

function getPostsDir(user) {
  return path.join(getUserDir(user), 'posts');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function unescapeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function buildPostHtml({ title, content }) {
  const safeTitle = escapeHtml(title || '게시글');
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
  <style>
    body{font-family:Arial,'Noto Sans KR',sans-serif;line-height:1.7;color:#222;margin:40px}
    main{max-width:860px;margin:0 auto}
    h1{font-size:28px;margin:0 0 24px}
    img,iframe,video{max-width:100%;border-radius:6px}
  </style>
</head>
<body>
  <main>
    <h1>${safeTitle}</h1>
    <article>
${content || ''}
    </article>
  </main>
</body>
</html>
`;
}

function getPostDir(user, id) {
  return path.join(getPostsDir(user), `post_${id}`);
}

async function ensureUserData(user) {
  const postsDir = getPostsDir(user);
  await fs.mkdir(postsDir, { recursive: true });
  await Promise.all(
    Array.from({ length: POST_COUNT }, (_, idx) => fs.mkdir(getPostDir(user, idx + 1), { recursive: true }))
  );
  try {
    await fs.access(getConfigPath(user));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await fs.writeFile(getConfigPath(user), `${JSON.stringify(defaultConfig(), null, 2)}\n`, 'utf8');
  }
}

async function ensureUserTable() {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      email VARCHAR(100),
      phone_number VARCHAR(30),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email VARCHAR(100),
    ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
    ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
  `);
  await pool.query(`
    UPDATE users
    SET is_admin = TRUE
    WHERE id = (SELECT id FROM users ORDER BY id LIMIT 1)
      AND NOT EXISTS (SELECT 1 FROM users WHERE is_admin = TRUE)
  `);
  await pool.query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'users'
          AND column_name = 'created_at'
          AND data_type = 'timestamp without time zone'
      ) THEN
        ALTER TABLE users
        ALTER COLUMN created_at TYPE TIMESTAMPTZ
        USING created_at AT TIME ZONE 'UTC';
      END IF;
    END
    $$
  `);
  await pool.query(`
    UPDATE users SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;
    ALTER TABLE users ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE users ALTER COLUMN created_at SET NOT NULL;
  `);
}

async function ensurePostingLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posting_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username VARCHAR(50) NOT NULL,
      slot_id INTEGER NOT NULL,
      slot_name VARCHAR(255) NOT NULL,
      post_id INTEGER,
      schedule_type VARCHAR(20),
      scheduled_for TIMESTAMPTZ NOT NULL,
      status VARCHAR(20) NOT NULL,
      reason TEXT,
      posted_url TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, slot_id, scheduled_for)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS posting_logs_user_created_idx
    ON posting_logs (user_id, created_at DESC)
  `);
}

async function reservePostingLog({ user, slot, scheduledFor, status = 'running', reason = '' }) {
  const result = await pool.query(
    `INSERT INTO posting_logs
      (user_id, username, slot_id, slot_name, post_id, schedule_type, scheduled_for, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id, slot_id, scheduled_for) DO NOTHING
     RETURNING id`,
    [
      user.id,
      user.username,
      slot.id,
      slot.name,
      slot.postId || null,
      slot.scheduleType || 'daily',
      scheduledFor,
      status,
      reason,
    ],
  );
  return result.rows[0]?.id || null;
}

async function completePostingLog(id, { status, reason = '', postedUrl = null, detail = {} }) {
  await pool.query(
    `UPDATE posting_logs
     SET status = $2, reason = $3, posted_url = $4, detail = $5::jsonb,
         post_id = COALESCE($6, post_id), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, status, reason, postedUrl, JSON.stringify(detail), detail.postId || null],
  );
}

async function findLogUser(user) {
  if (Number.isInteger(user?.id)) return user;
  const username = user?.username || user?.id;
  if (!username) return user;
  const found = await pool.query('SELECT id, username FROM users WHERE username = $1', [username]);
  return found.rows[0] || user;
}

function buildLiveSlot(slotId, body) {
  const postId = Number.parseInt(body.postId, 10);
  return {
    id: slotId,
    name: `게시 작업 슬롯 #${slotId}`,
    active: true,
    naverId: String(body.naverId || ''),
    naverPw: String(body.naverPw || ''),
    username: String(body.username || ''),
    cafeUrl: String(body.cafeUrl || ''),
    boardName: String(body.boardName || ''),
    postId: postId >= 1 && postId <= POST_COUNT ? postId : null,
    postTitle: String(body.postTitle || ''),
    mode: '직접',
    scheduleType: 'manual',
  };
}

async function enqueuePostingJob({ user, slot, slotId, scheduledFor, reason, trigger, livePayload = null }) {
  const logUser = await findLogUser(user);
  if (!Number.isInteger(logUser?.id)) {
    throw new Error('작업 로그를 생성할 사용자 정보를 찾지 못했습니다.');
  }

  const logId = await reservePostingLog({
    user: logUser,
    slot,
    scheduledFor,
    status: 'queued',
    reason,
  });
  if (!logId) return null;

  const job = await getPostingQueue().add('post-slot', {
    logId,
    user: { id: logUser.id, username: logUser.username },
    slotId,
    trigger,
    livePayload,
  }, {
    jobId: `posting-log-${logId}`,
  });

  await completePostingLog(logId, {
    status: 'queued',
    reason,
    detail: { queueJobId: job.id, trigger },
  });

  return { logId, jobId: job.id };
}

function mediaExtension(mime, fallback = 'bin') {
  const subtype = String(mime || '').split('/')[1] || fallback;
  return subtype
    .replace(/^svg\+xml$/, 'svg')
    .replace(/^jpeg$/, 'jpg')
    .replace(/[^a-z0-9]/gi, '') || fallback;
}

function safeAssetName(name, mime) {
  const parsed = path.parse(String(name || 'asset'));
  const base = (parsed.name || 'asset').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'asset';
  const ext = (parsed.ext || `.${mediaExtension(mime)}`).replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16) || '.bin';
  return `${Date.now()}_${base}${ext}`;
}

async function extractPostAssets(content, postDir) {
  let assetIndex = 0;
  const writes = [];
  const updatedContent = String(content || '').replace(
    /\b(src|href)=["']data:((?:image|video|audio)\/([^;]+));base64,([^"']+)["']/gi,
    (match, attr, mime, subtype, data) => {
      assetIndex += 1;
      const kind = mime.split('/')[0];
      const filename = `${kind}_${assetIndex}.${mediaExtension(mime, subtype)}`;
      writes.push(fs.writeFile(path.join(postDir, filename), Buffer.from(data, 'base64')));
      return `${attr}="./${filename}"`;
    }
  );

  await Promise.all(writes);
  return updatedContent;
}

function normalizePostAssetRefs(content, id) {
  const prefix = `/api/posts/${id}/assets/`;
  return String(content || '').replace(
    /\b(src|href)=["']([^"']+)["']/gi,
    (match, attr, url) => {
      if (!url.startsWith(prefix)) return match;
      const filename = path.basename(decodeURIComponent(url.slice(prefix.length)));
      return `${attr}="./${filename}"`;
    }
  );
}

function exposePostAssetRefs(content, id) {
  return String(content || '').replace(
    /\b(src|href)=["']\.\/([^"'\\/]+)["']/gi,
    (match, attr, filename) => `${attr}="/api/posts/${id}/assets/${encodeURIComponent(filename)}"`
  );
}

function collectAssetRefs(content) {
  const refs = new Set();
  String(content || '').replace(/\b(?:src|href)=["']\.\/([^"'\\/]+)["']/gi, (match, filename) => {
    refs.add(filename);
    return match;
  });
  return refs;
}

async function cleanupPostAssets(postDir, keepFiles) {
  const entries = await fs.readdir(postDir, { withFileTypes: true });
  await Promise.all(entries.map(entry => {
    if (!entry.isFile() || entry.name === 'index.html' || keepFiles.has(entry.name)) return Promise.resolve();
    return fs.rm(path.join(postDir, entry.name), { force: true });
  }));
}

function extractSavedPost(raw, id) {
  const titleMatch = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const articleMatch = raw.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const title = unescapeHtml((titleMatch ? titleMatch[1] : '').replace(/<[^>]+>/g, '').trim());
  const content = exposePostAssetRefs((articleMatch ? articleMatch[1] : '').trim(), id);
  return { title, content };
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
      `UPDATE users
       SET last_login_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id
         FROM users
         WHERE username = $1
           AND password = crypt($2, password)
           AND is_active = true
       )
       RETURNING id, username, last_login_at, created_at`,
      [username, password]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    req.session.user = { id: result.rows[0].id, username: result.rows[0].username };
    req.session.lastActivityAt = Date.now();
    req.session.cookie.maxAge = SESSION_TIMEOUT_MS;
    await ensureUserData(req.session.user);
    res.json({ success: true, redirect: '/dashboard' });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: '서버 오류가 발생했습니다.' });
  }
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({
    username: req.session.user.username,
    id: req.session.user.id,
    sessionRemainingSeconds: Math.ceil(getSessionRemainingMs(req) / 1000),
  });
});

app.post('/api/session/touch', requireLogin, (req, res) => {
  req.session.lastActivityAt = Date.now();
  req.session.cookie.maxAge = SESSION_TIMEOUT_MS;
  res.json({ sessionRemainingSeconds: SESSION_TIMEOUT_MS / 1000 });
});

// API Key 조회
app.get('/api/apikey', requireLogin, async (req, res) => {
  const key = await getUserApiKey(req.session.user.username);
  res.json({ key });
});

// API Key 생성 / 재생성
app.post('/api/apikey', requireLogin, async (req, res) => {
  try {
    await ensureUserData(req.session.user);
    const key = await generateApiKey(req.session.user.username);
    res.json({ key });
  } catch (err) {
    console.error('API key generate error:', err);
    res.status(500).json({ error: 'API Key 생성에 실패했습니다.' });
  }
});

// API Key 삭제 (비활성화)
app.delete('/api/apikey', requireLogin, async (req, res) => {
  try {
    const map = await getApiKeyMap();
    for (const [k, u] of Object.entries(map)) {
      if (u === req.session.user.username) delete map[k];
    }
    await saveApiKeyMap(map);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'API Key 삭제에 실패했습니다.' });
  }
});

app.get('/api/config', requireLogin, async (req, res) => {
  try {
    await ensureUserData(req.session.user);
    const raw = await fs.readFile(getConfigPath(req.session.user), 'utf8');
    const config = normalizeConfig(JSON.parse(raw));
    res.json({ ...config, cards: config.postCards });
  } catch (err) {
    console.error('Config read error:', err);
    res.status(500).json({ error: '설정을 불러오지 못했습니다.' });
  }
});

app.post('/api/config', requireLogin, async (req, res) => {
  try {
    await ensureUserData(req.session.user);
    let previous = { postCards: [], slots: [] };
    try {
      previous = normalizeConfig(JSON.parse(await fs.readFile(getConfigPath(req.session.user), 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const incoming = normalizeConfig(req.body);
    const payload = {
      postCards: (Array.isArray(req.body.postCards) || Array.isArray(req.body.cards)) ? incoming.postCards : previous.postCards,
      slots: Array.isArray(req.body.slots) ? incoming.slots : previous.slots,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(getConfigPath(req.session.user), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    res.json({ success: true, config: { ...payload, cards: payload.postCards } });
  } catch (err) {
    console.error('Config write error:', err);
    res.status(500).json({ error: '설정을 저장하지 못했습니다.' });
  }
});

app.get('/api/posting-logs', requireLogin, async (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
  const date = String(req.query.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)' });
  }

  try {
    const result = await pool.query(
      `SELECT id, slot_id, slot_name, post_id, schedule_type, scheduled_for,
              status, reason, posted_url, detail, created_at, updated_at
       FROM posting_logs
       WHERE user_id = $1
         AND status <> 'skipped'
         AND ($3::text = '' OR to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = $3)
       ORDER BY created_at DESC
       LIMIT $2`,
      [req.session.user.id, limit, date],
    );
    res.json({ logs: result.rows });
  } catch (err) {
    console.error('Posting logs read error:', err);
    res.status(500).json({ error: '게시 로그를 불러오지 못했습니다.' });
  }
});

app.get('/api/posts', requireLogin, async (req, res) => {
  try {
    await ensureUserData(req.session.user);
    const posts = await Promise.all(Array.from({ length: POST_COUNT }, async (_, idx) => {
      const id = idx + 1;
      const filePath = path.join(getPostDir(req.session.user, id), 'index.html');
      try {
        const raw = await fs.readFile(filePath, 'utf8');
        return { id, exists: true, ...extractSavedPost(raw, id) };
      } catch (err) {
        if (err.code === 'ENOENT') return { id, exists: false, title: '', content: '' };
        throw err;
      }
    }));
    res.json({ posts });
  } catch (err) {
    console.error('Posts read error:', err);
    res.status(500).json({ error: '게시글을 불러오지 못했습니다.' });
  }
});

app.get('/api/posts/:id/assets/:filename', requireLogin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const filename = path.basename(req.params.filename || '');
  if (!Number.isInteger(id) || id < 1 || id > POST_COUNT || !/^[a-zA-Z0-9_.-]+$/.test(filename)) {
    return res.status(400).json({ error: '파일 경로가 올바르지 않습니다.' });
  }

  const filePath = path.join(getPostDir(req.session.user, id), filename);
  res.sendFile(filePath, err => {
    if (err && !res.headersSent) res.status(err.statusCode || 404).end();
  });
});

app.post('/api/posts/:id/assets', requireLogin, express.raw({
  type: 'application/octet-stream',
  limit: '500mb',
}), async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > POST_COUNT) {
    return res.status(400).json({ error: '게시글 번호가 올바르지 않습니다.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: '업로드할 파일이 없습니다.' });
  }

  const mime = String(req.query.type || 'application/octet-stream');
  const originalName = String(req.query.name || 'asset');
  const filename = safeAssetName(originalName, mime);
  const postDir = getPostDir(req.session.user, id);
  const filePath = path.join(postDir, filename);

  try {
    await ensureUserData(req.session.user);
    await fs.mkdir(postDir, { recursive: true });
    await fs.writeFile(filePath, req.body);
    res.json({
      success: true,
      file: filename,
      url: `/api/posts/${id}/assets/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    console.error('Asset upload error:', err);
    res.status(500).json({ error: '파일을 업로드하지 못했습니다.' });
  }
});

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '파일이 너무 큽니다. 500MB 이하 파일만 업로드할 수 있습니다.' });
  }
  next(err);
});

app.post('/api/posts/:id', requireLogin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > POST_COUNT) {
    return res.status(400).json({ error: '게시글 번호가 올바르지 않습니다.' });
  }

  const title = String(req.body.title || '').trim() || `Post #${id}`;
  const postDir = getPostDir(req.session.user, id);
  const filename = 'index.html';
  const filePath = path.join(postDir, filename);

  try {
    await ensureUserData(req.session.user);
    await fs.mkdir(postDir, { recursive: true });
    const normalizedContent = normalizePostAssetRefs(req.body.content, id);
    const content = await extractPostAssets(normalizedContent, postDir);
    const html = buildPostHtml({ title, content });
    await fs.writeFile(filePath, html, 'utf8');
    await cleanupPostAssets(postDir, collectAssetRefs(content));
    res.json({ success: true, directory: `post_${id}`, file: filename });
  } catch (err) {
    console.error('Post write error:', err);
    res.status(500).json({ error: '게시글 HTML 파일을 저장하지 못했습니다.' });
  }
});

app.delete('/api/posts/:id', requireLogin, async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1 || id > POST_COUNT) {
    return res.status(400).json({ error: '게시글 번호가 올바르지 않습니다.' });
  }

  const postDir = getPostDir(req.session.user, id);
  try {
    await fs.rm(postDir, { recursive: true, force: true });
    await fs.mkdir(postDir, { recursive: true });
    res.json({ success: true, directory: `post_${id}` });
  } catch (err) {
    console.error('Post reset error:', err);
    res.status(500).json({ error: '게시글을 초기화하지 못했습니다.' });
  }
});

app.delete('/api/posts', requireLogin, async (req, res) => {
  try {
    await fs.rm(getPostsDir(req.session.user), { recursive: true, force: true });
    await ensureUserData(req.session.user);
    res.json({ success: true });
  } catch (err) {
    console.error('Posts reset error:', err);
    res.status(500).json({ error: '게시글 파일을 초기화하지 못했습니다.' });
  }
});

// ── Playwright 포스팅 실행 ─────────────────────────────────────────────────

function getSessionDir(user) {
  return path.join(getUserDir(user), 'sessions');
}

function getSessionPath(user, slotId) {
  return path.join(getSessionDir(user), `slot_${slotId}.json`);
}

const postingQueues = new Map();

async function withPostingQueue(naverId, task) {
  const key = String(naverId || '').trim().toLowerCase();
  const previous = postingQueues.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  postingQueues.set(key, current);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (postingQueues.get(key) === current) postingQueues.delete(key);
  }
}

async function advanceSequentialSlot(user, slotId, postedPostId) {
  const configPath = getConfigPath(user);
  const raw = await fs.readFile(configPath, 'utf8');
  const config = normalizeConfig(JSON.parse(raw));
  const slot = config.slots.find(item => item.id === slotId);
  if (!slot || slot.mode !== '순차적') return null;

  const nextPostId = getNextSequentialPostId(config, postedPostId);
  slot.postId = nextPostId;
  const payload = { ...config, updatedAt: new Date().toISOString() };
  await fs.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return nextPostId;
}

async function executeStoredSlot(user, slotId, config = null) {
  await ensureUserData(user);
  if (!config) {
    const raw = await fs.readFile(getConfigPath(user), 'utf8');
    config = normalizeConfig(JSON.parse(raw));
  }

  const slot = config.slots[slotId - 1];
  if (!slot) throw new Error('슬롯을 찾을 수 없습니다.');
  if (!slot.active) throw new Error('비활성화된 슬롯입니다.');
  if (!slot.naverId) throw new Error('NAVER ID가 설정되지 않았습니다.');
  if (!slot.naverPw) throw new Error('NAVER 비밀번호가 설정되지 않았습니다.');
  if (!slot.cafeUrl || slot.cafeUrl.includes('...')) throw new Error('카페 URL이 설정되지 않았습니다.');

  const postId = selectPostId(config, slot);
  const raw = await fs.readFile(path.join(getPostDir(user, postId), 'index.html'), 'utf8');
  const extracted = extractSavedPost(raw, postId);
  const sessionDir = getSessionDir(user);
  await fs.mkdir(sessionDir, { recursive: true });

  return withPostingQueue(slot.naverId, async () => {
    const NaverCafePoster = require('./playwright/naver');
    const poster = new NaverCafePoster({
      naverId: slot.naverId,
      naverPw: slot.naverPw,
      cafeUrl: slot.cafeUrl,
      boardName: slot.boardName || '',
      username: slot.username || '',
      sessionPath: getSessionPath(user, slotId),
    });

    try {
      await poster.launch();
      await poster.ensureLogin();
      const result = await poster.post({
        title: extracted.title || slot.postTitle || `Post #${postId}`,
        htmlContent: extracted.content || '',
        postDir: getPostDir(user, postId),
      });
      const nextPostId = slot.mode === '순차적'
        ? await advanceSequentialSlot(user, slot.id, postId)
        : null;
      return { success: true, url: result.url, log: poster.log, slot, postId, nextPostId };
    } catch (err) {
      err.posterLog = poster.log;
      throw err;
    } finally {
      try { await poster.close(); } catch { /* 브라우저 종료 오류 무시 */ }
    }
  });
}

async function executeLivePost(user, slotId, payload) {
  const naverId = String(payload.naverId || '');
  const naverPw = String(payload.naverPw || '');
  const username = String(payload.username || '');
  const cafeUrl = String(payload.cafeUrl || '');
  const boardName = String(payload.boardName || '');
  const postTitle = String(payload.postTitle || '');
  const postContent = String(payload.htmlContent || '');
  const postId = Number.parseInt(payload.postId, 10);
  const postDir = postId >= 1 && postId <= POST_COUNT ? getPostDir(user, postId) : null;

  if (!naverId) throw new Error('NAVER ID가 설정되지 않았습니다.');
  if (!naverPw) throw new Error('NAVER 비밀번호가 설정되지 않았습니다.');
  if (!cafeUrl || cafeUrl.includes('...')) throw new Error('카페 URL이 설정되지 않았습니다.');

  const sessionDir = getSessionDir(user);
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionPath = getSessionPath(user, slotId);

  return withPostingQueue(naverId, async () => {
    const NaverCafePoster = require('./playwright/naver');
    const poster = new NaverCafePoster({
      naverId,
      naverPw,
      cafeUrl,
      boardName,
      username,
      sessionPath,
    });
    try {
      await poster.launch();
      await poster.ensureLogin();
      const posted = await poster.post({ title: postTitle, htmlContent: postContent, postDir });
      return { ...posted, log: poster.log };
    } catch (err) {
      err.posterLog = poster.log;
      throw err;
    } finally {
      try { await poster.close(); } catch { /* 브라우저 종료 오류 무시 */ }
    }
  });
}

function evaluateSlotSchedule(config, slot, scheduleParts) {
  try {
    selectPostId(config, slot, 0);
  } catch (err) {
    return { due: false, reason: err.message };
  }

  const slotTime = normalizeScheduleTime(slot.time);
  if (!slotTime) return { due: false, reason: '글쓰기 시각이 올바르지 않습니다.' };
  if (slotTime !== scheduleParts.time) {
    return { due: false, reason: `예약 시각이 아닙니다. (예약 ${slotTime}, 현재 ${scheduleParts.time})` };
  }

  if (slot.scheduleType === 'weekly' && !slot.weekdays.includes(scheduleParts.weekday)) {
    return { due: false, reason: `오늘(${scheduleParts.weekday})은 활성화된 요일이 아닙니다.` };
  }
  return { due: true, reason: '예약 조건이 일치합니다.' };
}

async function processScheduledSlot(user, config, slot, scheduledFor, scheduleParts) {
  const evaluation = evaluateSlotSchedule(config, slot, scheduleParts);
  const prefix = `[Scheduler][${user.username}][Slot #${slot.id}]`;
  if (!evaluation.due) {
    console.log(`${prefix} SKIPPED: ${evaluation.reason}`);
    return;
  }

  try {
    const queued = await enqueuePostingJob({
      user,
      slot,
      slotId: slot.id,
      scheduledFor,
      reason: evaluation.reason,
      trigger: 'schedule',
    });
    if (queued) console.log(`${prefix} QUEUED: job ${queued.jobId}`);
  } catch (err) {
    console.error(`${prefix} QUEUE FAILED: ${err.message}`);
  }
}

let schedulerTickRunning = false;

async function runSchedulerTick(now = new Date()) {
  const scheduleParts = getSeoulScheduleParts(now);
  if (![0, 30].includes(scheduleParts.minute) || schedulerTickRunning) return;

  schedulerTickRunning = true;
  const scheduledFor = new Date(now);
  scheduledFor.setSeconds(0, 0);
  try {
    const users = await pool.query('SELECT id, username FROM users WHERE is_active = true ORDER BY id');
    const jobs = [];
    for (const user of users.rows) {
      try {
        await ensureUserData(user);
        const raw = await fs.readFile(getConfigPath(user), 'utf8');
        const config = normalizeConfig(JSON.parse(raw));
        for (const slot of config.slots.filter(item => item.active)) {
          jobs.push(processScheduledSlot(user, config, slot, scheduledFor, scheduleParts));
        }
      } catch (err) {
        console.error(`[Scheduler][${user.username}] 설정 확인 실패: ${err.message}`);
      }
    }
    await Promise.allSettled(jobs);
  } catch (err) {
    console.error(`[Scheduler] 실행 실패: ${err.message}`);
  } finally {
    schedulerTickRunning = false;
  }
}

app.post('/api/run-slot/:slotId', requireApiKeyOrLogin, async (req, res) => {
  const user   = getReqUser(req);
  const slotId = Number.parseInt(req.params.slotId, 10);
  if (!Number.isInteger(slotId) || slotId < 1 || slotId > 4) {
    return res.status(400).json({ error: '슬롯 번호가 올바르지 않습니다. (1~4)' });
  }

  const body = req.body || {};
  if (!body.naverId) {
    try {
      await ensureUserData(user);
      const config = normalizeConfig(JSON.parse(await fs.readFile(getConfigPath(user), 'utf8')));
      const slot = config.slots[slotId - 1];
      if (!slot) return res.status(404).json({ error: '슬롯을 찾을 수 없습니다.' });
      if (!slot.active) return res.status(400).json({ error: '비활성화된 슬롯입니다.' });
      if (!slot.naverId) return res.status(400).json({ error: 'NAVER ID가 설정되지 않았습니다.' });
      if (!slot.naverPw) return res.status(400).json({ error: 'NAVER 비밀번호가 설정되지 않았습니다.' });
      if (!slot.cafeUrl || slot.cafeUrl.includes('...')) return res.status(400).json({ error: '카페 URL이 설정되지 않았습니다.' });
      selectPostId(config, slot);

      const queued = await enqueuePostingJob({
        user,
        slot,
        slotId,
        scheduledFor: new Date(),
        reason: '게시 버튼으로 큐에 등록했습니다.',
        trigger: 'manual',
      });
      if (!queued) return res.status(409).json({ error: '이미 등록된 게시 작업입니다.' });
      return res.status(202).json({
        success: true,
        queued: true,
        jobId: queued.jobId,
        logId: queued.logId,
        message: '게시 작업이 큐에 등록되었습니다.',
      });
    } catch (err) {
      console.error(`Run-slot #${slotId} error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    const slot = buildLiveSlot(slotId, body);
    if (!slot.naverId) return res.status(400).json({ error: 'NAVER ID가 설정되지 않았습니다.' });
    if (!slot.naverPw) return res.status(400).json({ error: 'NAVER 비밀번호가 설정되지 않았습니다.' });
    if (!slot.cafeUrl || slot.cafeUrl.includes('...')) return res.status(400).json({ error: '카페 URL이 설정되지 않았습니다.' });

    const queued = await enqueuePostingJob({
      user,
      slot,
      slotId,
      scheduledFor: new Date(),
      reason: '외부 요청으로 큐에 등록했습니다.',
      trigger: 'api',
      livePayload: body,
    });
    if (!queued) return res.status(409).json({ error: '이미 등록된 게시 작업입니다.' });
    return res.status(202).json({
      success: true,
      queued: true,
      jobId: queued.jobId,
      logId: queued.logId,
      message: '게시 작업이 큐에 등록되었습니다.',
    });
  } catch (err) {
    console.error(`Run-slot #${slotId} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// 네이버 로그인 세션 초기화
app.delete('/api/run-slot/:slotId/session', requireApiKeyOrLogin, async (req, res) => {
  const user   = getReqUser(req);
  const slotId = Number.parseInt(req.params.slotId, 10);
  if (!Number.isInteger(slotId) || slotId < 1 || slotId > 4) {
    return res.status(400).json({ error: '슬롯 번호가 올바르지 않습니다.' });
  }
  try {
    await fs.rm(getSessionPath(user, slotId), { force: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '세션 삭제에 실패했습니다.' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

async function initializeApplication() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await ensureUserTable();
  await ensurePostingLogTable();
  app.listen(PORT, () => console.log(`Login server running on port ${PORT}`));
  setInterval(() => runSchedulerTick().catch(err => console.error('[Scheduler] tick error:', err)), 30 * 1000);
  runSchedulerTick().catch(err => console.error('[Scheduler] initial tick error:', err));
}

if (require.main === module) {
  initializeApplication().catch(err => {
    console.error('Application init error:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  completePostingLog,
  ensurePostingLogTable,
  ensureUserData,
  ensureUserTable,
  executeLivePost,
  executeStoredSlot,
  evaluateSlotSchedule,
  getActivePostIds,
  getNextSequentialPostId,
  getSeoulScheduleParts,
  pool,
  normalizeScheduleTime,
  runSchedulerTick,
  selectPostId,
  withPostingQueue,
};
