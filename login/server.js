const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const path = require('path');
const fs = require('fs/promises');

const app = express();
const PORT = 3000;
const FLOWISE_URL = process.env.FLOWISE_URL || 'http://localhost:3991';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const POST_COUNT = 12;

const pool = new Pool({
  host: process.env.DB_HOST || 'easypost_postgres',
  port: parseInt(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'easypost',
  password: process.env.DB_PASSWORD || 'easypost123',
  database: 'EasyPost_USER',
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
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
      cafeUrl: String(slot.cafeUrl || ''),
      boardName: String(slot.boardName || ''),
      postId: Number.parseInt(slot.postId, 10) || 1,
      postTitle: String(slot.postTitle || ''),
      mode: String(slot.mode || '순차적'),
      time: String(slot.time || ''),
    })),
  };
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
    await ensureUserData(req.session.user);
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

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

fs.mkdir(DATA_DIR, { recursive: true })
  .catch(err => console.error('Data directory init error:', err))
  .finally(() => app.listen(PORT, () => console.log(`Login server running on port ${PORT}`)));
