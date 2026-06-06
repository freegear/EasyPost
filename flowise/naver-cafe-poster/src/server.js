import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { NaverCafePoster } from './poster.js';

const app = express();
const PORT = Number(process.env.PORT || 3011);
const SESSION_DIR = process.env.SESSION_DIR || '/sessions';

app.use(express.json({ limit: '10mb' }));

function sessionFile(username) {
  const safe = String(username || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return path.join(SESSION_DIR, `${safe}.json`);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'naver-cafe-poster' });
});

app.post('/post', async (req, res) => {
  const { username, naverId, naverPw, cafeUrl, boardName, title, htmlContent } = req.body || {};

  if (!username) {
    return res.status(400).json({ ok: false, message: 'username is required' });
  }
  if (!cafeUrl) {
    return res.status(400).json({ ok: false, message: 'cafeUrl is required' });
  }
  if (!title) {
    return res.status(400).json({ ok: false, message: 'title is required' });
  }

  await fs.mkdir(SESSION_DIR, { recursive: true });
  const sPath = sessionFile(username);

  const poster = new NaverCafePoster({ sessionPath: sPath, cafeUrl, boardName });
  try {
    await poster.launch();
    await poster.ensureLogin(naverId || username, naverPw);
    const result = await poster.post({ title, htmlContent: htmlContent || '' });
    return res.json({ ok: true, url: result.url, log: poster.log });
  } catch (err) {
    return res.status(500).json({ ok: false, message: err.message, log: poster.log });
  } finally {
    await poster.close();
  }
});

app.listen(PORT, () => console.log(`naver-cafe-poster listening on ${PORT}`));
