'use strict';

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs/promises');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-blink-features=AutomationControlled',
];

class NaverCafePoster {
  constructor({ naverId, naverPw, cafeUrl, boardName, sessionPath }) {
    this.naverId  = naverId;
    this.naverPw  = naverPw;
    this.cafeUrl  = cafeUrl;
    this.boardName = boardName;
    this.sessionPath = sessionPath;
    this.browser = null;
    this.context = null;
    this.page    = null;
    this.log     = [];
  }

  _log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    this.log.push(line);
  }

  // ─── 브라우저 초기화 ───────────────────────────────────────────────────────

  async launch() {
    this._log('브라우저 시작');
    this.browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });

    let storageState;
    try {
      await fs.access(this.sessionPath);
      storageState = this.sessionPath;
      this._log('저장된 세션 로드');
    } catch { /* 세션 없음 — 새로 로그인 */ }

    this.context = await this.browser.newContext({
      storageState,
      userAgent: USER_AGENT,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = await this.context.newPage();
    this._log('브라우저 초기화 완료');
  }

  // ─── 로그인 ────────────────────────────────────────────────────────────────

  async ensureLogin() {
    this._log('로그인 상태 확인');
    await this.page.goto('https://www.naver.com', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const loggedIn = await this.page.evaluate(() => {
      return !document.querySelector('a.link_login, a[href*="nidlogin"]');
    });

    if (loggedIn) {
      this._log('이미 로그인 상태');
      return;
    }

    await this._login();
  }

  async _login() {
    this._log('네이버 로그인 시작');
    await this.page.goto(
      'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com%2F',
      { waitUntil: 'domcontentloaded', timeout: 30000 },
    );

    await this.page.evaluate(
      ({ id, pw }) => {
        const setNativeValue = (el, value) => {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value',
          ).set;
          nativeInputValueSetter.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const idEl = document.getElementById('id');
        const pwEl = document.getElementById('pw');
        if (idEl) setNativeValue(idEl, id);
        if (pwEl) setNativeValue(pwEl, pw);
      },
      { id: this.naverId, pw: this.naverPw },
    );

    await this.page.waitForTimeout(500);
    await this.page.click('.btn_login');
    await this.page.waitForTimeout(3000);

    const url = this.page.url();
    if (url.includes('nidlogin')) {
      throw new Error('로그인 실패: ID 또는 비밀번호를 확인해주세요.');
    }
    if (url.includes('captcha') || url.includes('otp') || url.includes('protect')) {
      throw new Error('추가 인증이 필요합니다 (OTP / CAPTCHA). 브라우저에서 직접 로그인 후 다시 시도해주세요.');
    }

    await this.context.storageState({ path: this.sessionPath });
    this._log('로그인 성공 — 세션 저장');
  }

  // ─── 카페 ID 추출 ──────────────────────────────────────────────────────────

  async _getCafeId() {
    const url = new URL(this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`);
    const idFromPath = url.pathname.match(/\/cafes\/(\d+)/);
    if (idFromPath) return idFromPath[1];

    this._log(`카페 ID 추출 중: ${this.cafeUrl}`);
    await this.page.goto(this.cafeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cafeId = await this.page.evaluate(() => {
      const urlMatch = location.href.match(/\/cafes\/(\d+)/);
      if (urlMatch) return urlMatch[1];
      const meta = document.querySelector('meta[property="og:url"]');
      if (meta) {
        const m = (meta.content || '').match(/cafes\/(\d+)/);
        if (m) return m[1];
      }
      for (const key of Object.keys(window)) {
        if (key.includes('cafe') || key.includes('Club')) {
          const val = window[key];
          if (typeof val === 'object' && val && val.clubId) return String(val.clubId);
          if (typeof val === 'number' && val > 1000000) return String(val);
        }
      }
      for (const s of document.querySelectorAll('script')) {
        const m = s.textContent.match(/["']?clubId["']?\s*[=:]\s*["']?(\d{7,})["']?/);
        if (m) return m[1];
      }
      return null;
    });

    if (!cafeId) throw new Error('카페 ID를 찾을 수 없습니다.');
    this._log(`카페 ID: ${cafeId}`);
    return cafeId;
  }

  // ─── 게시판 선택 ───────────────────────────────────────────────────────────

  async _selectBoard() {
    if (!this.boardName) return;
    this._log(`게시판 선택: ${this.boardName}`);
    try {
      const boardEl = await this.page.waitForSelector(
        `text="${this.boardName}"`, { timeout: 5000 },
      );
      await boardEl.click();
      await this.page.waitForTimeout(500);
      this._log('게시판 선택 완료');
    } catch {
      this._log(`게시판 "${this.boardName}" 을 찾지 못했습니다 — 기본 게시판 사용`);
    }
  }

  // ─── 제목 입력 ─────────────────────────────────────────────────────────────

  async _fillTitle(title) {
    this._log('제목 입력');
    const selectors = [
      'input[placeholder="제목을 입력해 주세요."]',
      'textarea[placeholder="제목을 입력해 주세요."]',
      '.se-title-text', '.se-title-input',
      '[class*="title"] input', '[class*="title"] textarea',
      '.FlexableTextArea textarea',
      'input[placeholder*="제목"]', 'textarea[placeholder*="제목"]',
      'input.se-title-input', '.se-title-container input', '#subject',
    ];

    let titleEl = null;
    for (const sel of selectors) {
      try {
        titleEl = await this.page.waitForSelector(sel, { timeout: 5000 });
        break;
      } catch { /* 다음 시도 */ }
    }

    if (!titleEl) throw new Error('제목 입력창을 찾을 수 없습니다.');
    await titleEl.click();
    await titleEl.fill(title);
    this._log('제목 입력 완료');
  }

  // ─── HTML → 세그먼트 분리 ─────────────────────────────────────────────────
  // 이미지/동영상 태그 기준으로 텍스트와 로컬 미디어 블록 순서 배열 반환

  _parseSegments(htmlContent, postDir) {
    const segments = [];
    const mediaRegex = /<img\b[^>]*>|<video\b[^>]*>[\s\S]*?<\/video>/gi;
    let lastIndex = 0;
    let match;

    const resolveMediaPath = src => {
      if (!postDir || !src) return null;
      const assetMatch = src.match(/\/api\/posts\/\d+\/assets\/([^"'?\s]+)/);
      if (assetMatch) return path.join(postDir, decodeURIComponent(assetMatch[1]));
      if (!src.startsWith('http') && !src.startsWith('data:')) {
        return path.join(postDir, src.replace(/^\.\//, ''));
      }
      return null;
    };

    while ((match = mediaRegex.exec(htmlContent)) !== null) {
      if (match.index > lastIndex) {
        const chunk = htmlContent.slice(lastIndex, match.index);
        if (chunk.trim()) segments.push({ type: 'html', content: chunk });
      }

      const tag = match[0];
      const type = /^<video\b/i.test(tag) ? 'video' : 'image';
      const ownSrc = tag.match(/^<(?:img|video)\b[^>]*\bsrc=["']([^"']+)["']/i);
      const sourceSrc = tag.match(/<source\b[^>]*\bsrc=["']([^"']+)["']/i);
      const mediaPath = resolveMediaPath(ownSrc?.[1] || sourceSrc?.[1]);
      if (mediaPath) segments.push({ type, path: mediaPath });
      else segments.push({ type: 'html', content: tag });

      lastIndex = match.index + match[0].length;
    }

    // 마지막 텍스트
    if (lastIndex < htmlContent.length) {
      const chunk = htmlContent.slice(lastIndex);
      if (chunk.trim()) segments.push({ type: 'html', content: chunk });
    }

    return segments;
  }

  // ─── 클립보드 HTML 붙여넣기 ───────────────────────────────────────────────

  async _pasteHtml(html) {
    const clipOk = await this.page.evaluate(async (h) => {
      try {
        const plain = h
          .replace(/<p[^>]*>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<\/div>/gi, '\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>');
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html':  new Blob([h],     { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' }),
          }),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }, html);

    if (!clipOk.ok) throw new Error(`클립보드 실패: ${clipOk.reason}`);

    await this.page.evaluate(() => {
      document.querySelector('div[contenteditable="true"]').focus();
    });
    await this.page.waitForTimeout(200);
    await this.page.keyboard.press('Control+v');
    await this.page.waitForTimeout(1000);
  }

  // ─── 이미지 삽입 (로컬 파일 → SmartEditor Drag & Drop) ───────────────────

  async _insertImage(imagePath) {
    this._log(`이미지 업로드 시작: ${path.basename(imagePath)}`);

    await fs.access(imagePath);
    const imageCount = await this.page.locator('.se-component.se-image').count();
    const editor = this.page.locator('.se-content').first();
    await editor.waitFor({ state: 'visible', timeout: 10000 });

    const bottom = this.page.locator('.se-canvas-bottom').first();
    await bottom.waitFor({ state: 'attached', timeout: 10000 });
    await bottom.scrollIntoViewIfNeeded();

    const viewport = this.page.viewportSize();
    const box = await bottom.boundingBox();
    if (!box) throw new Error('이미지 Drag & Drop 대상 좌표를 찾을 수 없습니다.');

    // 본문 문단과 중앙의 글감 메뉴를 피해서 canvas-bottom 왼쪽 하단에 Drop한다.
    const x = box.x + 50;
    const y = Math.min(box.y + box.height - 30, (viewport?.height || 900) - 30);
    const dropTargetClass = await this.page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.className || '',
      { x, y },
    );
    if (!String(dropTargetClass).includes('se-canvas-bottom')) {
      throw new Error(`이미지 Drag & Drop 대상이 올바르지 않습니다: ${dropTargetClass || 'unknown'}`);
    }

    const data = { items: [], files: [imagePath], dragOperationsMask: 1 };
    const client = await this.context.newCDPSession(this.page);

    try {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await client.send('Input.dispatchDragEvent', { type, x, y, data });
        await this.page.waitForTimeout(300);
      }
    } finally {
      await client.detach();
    }

    this._log('이미지 Drag & Drop 이벤트 전달 완료');
    try {
      await this.page.waitForFunction(
        previousCount => document.querySelectorAll('.se-component.se-image').length > previousCount,
        imageCount,
        { timeout: 30000 },
      );
      this._log('이미지 업로드 완료 (에디터 이미지 확인)');
    } catch {
      throw new Error(`이미지 Drag & Drop 후 업로드를 확인하지 못했습니다: ${path.basename(imagePath)}`);
    }
  }

  // ─── 동영상 삽입 (SmartEditor 동영상 업로더) ───────────────────────────────

  async _insertVideo(videoPath) {
    this._log(`동영상 업로드 시작: ${path.basename(videoPath)}`);
    await fs.access(videoPath);

    const videoCount = await this.page.locator('.se-component.se-video').count();
    await this.page.locator('button.se-video-toolbar-button').click({ timeout: 10000 });

    const popup = this.page.locator('.se-popup-container').filter({ hasText: '동영상 업로더' }).first();
    await popup.waitFor({ state: 'visible', timeout: 10000 });

    const [fileChooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 10000 }),
      popup.locator('button.nvu_btn_append.nvu_local, button.nvu_btn_append.nvu_btn_local').first().click(),
    ]);
    await fileChooser.setFiles(videoPath);
    this._log('동영상 파일 선택 완료');

    await this.page.waitForFunction(
      () => Array.from(document.querySelectorAll('.se-popup-container'))
        .some(el => el.offsetParent !== null && el.textContent.includes('업로드 완료')),
      undefined,
      { timeout: 5 * 60 * 1000 },
    );
    this._log('동영상 업로드 완료');

    await this.page.locator('button.nvu_btn_submit:visible').last().click({ timeout: 10000 });
    await this.page.waitForFunction(
      previousCount => document.querySelectorAll('.se-component.se-video').length > previousCount,
      videoCount,
      { timeout: 30000 },
    );
    this._log('동영상 본문 삽입 완료');
  }

  // ─── 본문 입력 ─────────────────────────────────────────────────────────────

  async _fillContent(htmlContent, postDir) {
    this._log('본문 입력 시작');

    // contenteditable 에디터 대기
    await this.page.waitForSelector('div[contenteditable="true"]', { timeout: 20000 });
    this._log('에디터 영역 확인');

    // 에디터 포커스 및 기존 내용 제거
    await this.page.evaluate(() => {
      const el = document.querySelector('div[contenteditable="true"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
    });
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press('Delete');
    await this.page.waitForTimeout(200);

    // HTML에서 로컬 이미지/동영상 추출 → 세그먼트 분리
    const segments = this._parseSegments(htmlContent, postDir);
    const mediaSegments = segments.filter(s => s.type === 'image' || s.type === 'video');

    this._log(
      `세그먼트: ${segments.length}개 ` +
      `(이미지 ${segments.filter(s => s.type === 'image').length}개, ` +
      `동영상 ${segments.filter(s => s.type === 'video').length}개)`,
    );

    if (mediaSegments.length === 0) {
      // 로컬 미디어 없음: 클립보드 붙여넣기
      await this._pasteHtml(htmlContent);
      this._log('본문 입력 완료');
      return;
    }

    // 텍스트 + 로컬 미디어 순서대로 처리
    for (const seg of segments) {
      if (seg.type === 'html') {
        await this._pasteHtml(seg.content);
      } else if (seg.type === 'image') {
        await this._insertImage(seg.path);
      } else if (seg.type === 'video') {
        await this._insertVideo(seg.path);
      }
    }

    this._log('본문 입력 완료 (텍스트+미디어)');
  }

  // ─── 게시 제출 ─────────────────────────────────────────────────────────────

  async _submit() {
    this._log('등록 버튼 클릭');
    const submitSelectors = [
      'a.BaseButton--skinGreen',
      '.ArticleWriteContainer a.BaseButton',
      '.WritingHeader a.BaseButton',
      'a:has-text("등록")',
      'button:has-text("등록")',
      'button.se-publish-btn',
      'button[data-action="publish"]',
      'input[type="submit"][value*="등록"]',
      '#btn_upload',
    ];

    for (const sel of submitSelectors) {
      try {
        await this.page.click(sel, { timeout: 3000 });
        this._log(`등록 버튼 클릭 완료 (${sel})`);
        return;
      } catch { /* 다음 시도 */ }
    }

    throw new Error('등록 버튼을 찾을 수 없습니다.');
  }

  // ─── 공개 메서드: 포스팅 실행 ──────────────────────────────────────────────

  async post({ title, htmlContent, postDir }) {
    const rawUrl = this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`;

    const cafeIdMatch = rawUrl.match(/\/cafes\/(\d+)/);
    const menuIdMatch = rawUrl.match(/\/menus\/(\d+)/);
    const cafeId = cafeIdMatch ? cafeIdMatch[1] : await this._getCafeId();
    const menuId = menuIdMatch ? menuIdMatch[1] : null;

    const writeUrl = menuId
      ? `https://cafe.naver.com/ca-fe/cafes/${cafeId}/menus/${menuId}/articles/write?boardType=L`
      : `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/write`;

    this._log(`글쓰기 페이지 이동: ${writeUrl}`);
    await this.page.goto(writeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(1500);

    if (!menuId) await this._selectBoard();
    await this._fillTitle(title);
    await this._fillContent(htmlContent, postDir);
    await this._submit();

    let postedUrl = this.page.url();
    for (let i = 0; i < 30; i++) {
      await this.page.waitForTimeout(500);
      postedUrl = this.page.url();
      if (!postedUrl.includes('/write')) break;
    }

    this._log(`게시 완료: ${postedUrl}`);
    return { url: postedUrl };
  }

  // ─── 정리 ──────────────────────────────────────────────────────────────────

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

module.exports = NaverCafePoster;
