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
    // 클립보드 권한 부여 (HTML 클립보드 붙여넣기에 필요)
    await this.context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // navigator.webdriver 숨김
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

    // JS로 입력 (keyboard typing 대신 → 봇 탐지 우회)
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

    // 로그인 처리 대기
    await this.page.waitForTimeout(3000);

    const url = this.page.url();

    if (url.includes('nidlogin')) {
      throw new Error('로그인 실패: ID 또는 비밀번호를 확인해주세요.');
    }
    if (url.includes('captcha') || url.includes('otp') || url.includes('protect')) {
      throw new Error('추가 인증이 필요합니다 (OTP / CAPTCHA). 브라우저에서 직접 로그인 후 다시 시도해주세요.');
    }

    // 세션 저장
    await this.context.storageState({ path: this.sessionPath });
    this._log('로그인 성공 — 세션 저장');
  }

  // ─── 카페 ID 추출 ──────────────────────────────────────────────────────────

  async _getCafeId() {
    const url = new URL(this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`);

    // 이미 숫자 ID가 경로에 있는 경우
    const idFromPath = url.pathname.match(/\/cafes\/(\d+)/);
    if (idFromPath) return idFromPath[1];

    // 카페 이름으로 접근 → ID 추출
    this._log(`카페 ID 추출 중: ${this.cafeUrl}`);
    await this.page.goto(this.cafeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cafeId = await this.page.evaluate(() => {
      // 1) URL에서 추출
      const urlMatch = location.href.match(/\/cafes\/(\d+)/);
      if (urlMatch) return urlMatch[1];
      // 2) meta og:url
      const meta = document.querySelector('meta[property="og:url"]');
      if (meta) {
        const m = (meta.content || '').match(/cafes\/(\d+)/);
        if (m) return m[1];
      }
      // 3) window 전역 변수
      for (const key of Object.keys(window)) {
        if (key.includes('cafe') || key.includes('Club')) {
          const val = window[key];
          if (typeof val === 'object' && val && val.clubId) return String(val.clubId);
          if (typeof val === 'number' && val > 1000000) return String(val);
        }
      }
      // 4) 스크립트 텍스트에서 clubId 추출
      for (const s of document.querySelectorAll('script')) {
        const m = s.textContent.match(/["']?clubId["']?\s*[=:]\s*["']?(\d{7,})["']?/);
        if (m) return m[1];
      }
      return null;
    });

    if (!cafeId) throw new Error('카페 ID를 찾을 수 없습니다. 카페 URL을 확인해주세요.');
    this._log(`카페 ID: ${cafeId}`);
    return cafeId;
  }

  // ─── 게시판 선택 ───────────────────────────────────────────────────────────

  async _selectBoard() {
    if (!this.boardName) return;
    this._log(`게시판 선택: ${this.boardName}`);

    try {
      // 게시판 드롭다운/목록에서 boardName 클릭
      const boardEl = await this.page.waitForSelector(
        `text="${this.boardName}"`,
        { timeout: 5000 },
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
      // ca-fe 직접 페이지 (SmartEditor ONE)
      'input[placeholder="제목을 입력해 주세요."]',
      'textarea[placeholder="제목을 입력해 주세요."]',
      '.se-title-text',
      '.se-title-input',
      '[class*="title"] input',
      '[class*="title"] textarea',
      // f-e SPA 내부 프레임
      '.FlexableTextArea textarea',
      // 범용 폴백
      'input[placeholder*="제목"]',
      'textarea[placeholder*="제목"]',
      'input.se-title-input',
      '.se-title-container input',
      '#subject',
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

  // ─── 본문 입력 (클립보드 HTML → Ctrl+V 붙여넣기) ───────────────────────
  // 수동 copy-paste와 동일한 경로 사용:
  //   navigator.clipboard.write(HTML) → Ctrl+V(trusted) → SmartEditor paste 핸들러
  // setDocumentData() 방식은 빈 단락 내부 표현이 달라 빈 줄이 사라짐.

  async _fillContent(htmlContent) {
    this._log('본문 입력 시작');

    // contenteditable 에디터 영역 대기 (SmartEditor 초기화 완료 신호)
    const editorEl = await this.page.waitForSelector(
      'div[contenteditable="true"]',
      { timeout: 20000 },
    );
    this._log('에디터 영역 확인');

    // JS로 직접 focus (click은 viewport 좌표 기반 → 스크롤 컨테이너 안에서 실패)
    await this.page.evaluate(() => {
      const el = document.querySelector('div[contenteditable="true"]');
      if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
    });
    await this.page.waitForTimeout(300);
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);
    await this.page.keyboard.press('Delete');
    await this.page.waitForTimeout(200);

    // HTML을 클립보드에 설정 (text/html + text/plain 동시 제공)
    const clipOk = await this.page.evaluate(async (html) => {
      try {
        // plain text: 빈 <p> → 빈 줄(\n), 내용 있는 </p> → 줄바꿈
        const plain = html
          .replace(/<p[^>]*>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, '\n')
          .replace(/<\/p>/gi, '\n')
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>');
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' }),
          }),
        ]);
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: e.message };
      }
    }, htmlContent);

    if (!clipOk.ok) {
      this._log(`클립보드 설정 실패: ${clipOk.reason}`);
      // 폴백: 일반 textarea
      try {
        const textarea = await this.page.waitForSelector(
          'textarea#body, textarea[name="body"]',
          { timeout: 3000 },
        );
        const plain = htmlContent.replace(/<[^>]+>/g, '').trim();
        await textarea.fill(plain);
        this._log('본문 입력 완료 (폴백: textarea)');
        return;
      } catch { /* 실패 */ }
      throw new Error(`본문 입력 실패: 클립보드 설정 불가 (${clipOk.reason})`);
    }

    // Ctrl+V — Playwright CDP 경유 → isTrusted:true → SmartEditor paste 핸들러 정상 실행
    await this.page.evaluate(() => {
      document.querySelector('div[contenteditable="true"]').focus();
    });
    await this.page.waitForTimeout(200);
    await this.page.keyboard.press('Control+v');
    await this.page.waitForTimeout(1500);
    this._log('본문 입력 완료 (클립보드 HTML Ctrl+V 붙여넣기)');
  }

  // ─── 게시 제출 ─────────────────────────────────────────────────────────────

  async _submit() {
    this._log('등록 버튼 클릭');
    const submitSelectors = [
      // ca-fe 직접 페이지 (스크린샷 기준)
      'a.BaseButton--skinGreen',
      '.ArticleWriteContainer a.BaseButton',
      '.WritingHeader a.BaseButton',
      'a:has-text("등록")',
      // 범용
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

  async post({ title, htmlContent }) {
    const rawUrl = this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`;

    const cafeIdMatch = rawUrl.match(/\/cafes\/(\d+)/);
    const menuIdMatch = rawUrl.match(/\/menus\/(\d+)/);
    const cafeId = cafeIdMatch ? cafeIdMatch[1] : await this._getCafeId();
    const menuId = menuIdMatch ? menuIdMatch[1] : null;

    // menuId가 있으면 ca-fe 직접 URL로 이동 (게시판 자동 선택)
    const writeUrl = menuId
      ? `https://cafe.naver.com/ca-fe/cafes/${cafeId}/menus/${menuId}/articles/write?boardType=L`
      : `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/write`;

    this._log(`글쓰기 페이지 이동: ${writeUrl}`);
    await this.page.goto(writeUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await this.page.waitForTimeout(1500); // SmartEditor 초기화 대기

    if (!menuId) await this._selectBoard();
    await this._fillTitle(title);
    await this._fillContent(htmlContent);
    await this._submit();

    // 게시 후 /write URL에서 벗어날 때까지 폴링 (SPA 내비게이션 대응)
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
