import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const app = express();

const PORT = Number(process.env.PORT || 3010);
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const SESSION_DIR = process.env.SESSION_DIR || '/sessions';
const NAVER_LOGIN_URL = process.env.NAVER_LOGIN_URL || 'https://nid.naver.com/nidlogin.login';

app.use(express.json({ limit: '1mb' }));

function userSessionFile(username) {
  const safeName = String(username || 'default')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80);
  return path.join(SESSION_DIR, `${safeName}.json`);
}

async function detectLoginState(page) {
  const url = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 3000 }).catch(() => '');

  if (/captcha|자동입력|보안문자/i.test(bodyText)) {
    return { ok: false, status: 'verification_required', reason: 'captcha_required' };
  }

  if (/2단계|OTP|인증번호|본인 확인|추가 인증/i.test(bodyText)) {
    return { ok: false, status: 'verification_required', reason: 'additional_verification_required' };
  }

  if (!url.includes('nid.naver.com')) {
    return { ok: true, status: 'logged_in' };
  }

  if (/아이디 또는 비밀번호|로그인 정보가 올바르지/i.test(bodyText)) {
    return { ok: false, status: 'login_failed', reason: 'invalid_credentials' };
  }

  return { ok: false, status: 'login_failed', reason: 'login_page_still_visible' };
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'naver-login-agent' });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({
      ok: false,
      status: 'bad_request',
      message: 'username and password are required'
    });
  }

  let browser;
  try {
    await fs.mkdir(SESSION_DIR, { recursive: true });

    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--disable-blink-features=AutomationControlled']
    });

    const context = await browser.newContext({
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1365, height: 900 }
    });
    const page = await context.newPage();

    await page.goto(NAVER_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('#id').fill(username, { timeout: 10000 });
    await page.locator('#pw').fill(password, { timeout: 10000 });
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      page.locator('#log\\.login, .btn_login, button[type="submit"]').first().click({ timeout: 10000 })
    ]);

    await page.waitForTimeout(2000);

    const state = await detectLoginState(page);
    if (state.ok) {
      const sessionFile = userSessionFile(username);
      await context.storageState({ path: sessionFile });
      await browser.close();
      return res.json({
        ...state,
        sessionFile,
        message: 'Naver login session was saved.'
      });
    }

    const screenshotFile = path.join(SESSION_DIR, `${path.basename(userSessionFile(username), '.json')}.last.png`);
    await page.screenshot({ path: screenshotFile, fullPage: true }).catch(() => {});
    await browser.close();
    return res.status(409).json({
      ...state,
      screenshotFile,
      message: 'Manual verification may be required. Captcha or 2-step verification is not bypassed.'
    });
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({
      ok: false,
      status: 'error',
      message: error.message
    });
  }
});

app.delete('/sessions/:username', async (req, res) => {
  const sessionFile = userSessionFile(req.params.username);
  const screenshotFile = path.join(SESSION_DIR, `${path.basename(sessionFile, '.json')}.last.png`);
  await fs.rm(sessionFile, { force: true }).catch(() => {});
  await fs.rm(screenshotFile, { force: true }).catch(() => {});
  res.json({ ok: true, status: 'deleted' });
});

app.listen(PORT, () => {
  console.log(`naver-login-agent listening on ${PORT}`);
});
