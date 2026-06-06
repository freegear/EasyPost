import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs/promises';

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

// SmartEditor ONE 에디터 ID (동적 탐색 사용, 기본값은 참조용)
const SE_EDITOR_ID_FALLBACK = 'cafepc001';

export class NaverCafePoster {
  constructor({ sessionPath, cafeUrl, boardName }) {
    this.sessionPath = sessionPath;
    this.cafeUrl     = cafeUrl;
    this.boardName   = boardName;
    this.browser     = null;
    this.context     = null;
    this.page        = null;
    this.log         = [];
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
    } catch { /* 세션 없음 */ }

    this.context = await this.browser.newContext({
      storageState,
      userAgent: USER_AGENT,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
    });

    await this.context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    this.page = await this.context.newPage();
    this._log('브라우저 초기화 완료');
  }

  // ─── 로그인 ────────────────────────────────────────────────────────────────

  async ensureLogin(naverId, naverPw) {
    this._log('로그인 상태 확인');
    await this.page.goto('https://www.naver.com', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    const loggedIn = await this.page.evaluate(
      () => !document.querySelector('a.link_login, a[href*="nidlogin"]'),
    );
    if (loggedIn) { this._log('이미 로그인 상태'); return; }

    if (!naverId || !naverPw) throw new Error('세션이 없고 naverId/naverPw도 제공되지 않았습니다.');
    await this._login(naverId, naverPw);
  }

  async _login(naverId, naverPw) {
    this._log('네이버 로그인 시작');
    await this.page.goto(
      'https://nid.naver.com/nidlogin.login?mode=form&url=https%3A%2F%2Fwww.naver.com%2F',
      { waitUntil: 'domcontentloaded', timeout: 30000 },
    );

    await this.page.evaluate(
      ({ id, pw }) => {
        const set = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const idEl = document.getElementById('id');
        const pwEl = document.getElementById('pw');
        if (idEl) set(idEl, id);
        if (pwEl) set(pwEl, pw);
      },
      { id: naverId, pw: naverPw },
    );

    await this.page.waitForTimeout(500);
    await this.page.click('.btn_login');
    await this.page.waitForTimeout(3000);

    const url = this.page.url();
    if (url.includes('nidlogin')) throw new Error('로그인 실패: ID 또는 비밀번호를 확인해주세요.');
    if (url.includes('captcha') || url.includes('otp') || url.includes('protect'))
      throw new Error('추가 인증이 필요합니다 (OTP / CAPTCHA).');

    await this.context.storageState({ path: this.sessionPath });
    this._log('로그인 성공 — 세션 저장');
  }

  // ─── 카페 ID 추출 ──────────────────────────────────────────────────────────

  async _getCafeId() {
    const rawUrl = this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`;
    const idFromUrl = rawUrl.match(/\/cafes\/(\d+)/);
    if (idFromUrl) return idFromUrl[1];

    this._log(`카페 ID 추출 중: ${rawUrl}`);
    await this.page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const cafeId = await this.page.evaluate(() => {
      const m = location.href.match(/\/cafes\/(\d+)/);
      if (m) return m[1];
      const meta = document.querySelector('meta[property="og:url"]');
      if (meta) { const m2 = (meta.content || '').match(/cafes\/(\d+)/); if (m2) return m2[1]; }
      for (const s of document.querySelectorAll('script')) {
        const m3 = s.textContent.match(/["']?clubId["']?\s*[=:]\s*["']?(\d{7,})["']?/);
        if (m3) return m3[1];
      }
      return null;
    });
    if (!cafeId) throw new Error('카페 ID를 찾을 수 없습니다.');
    this._log(`카페 ID: ${cafeId}`);
    return cafeId;
  }

  // ─── 게시판 menuId 추출 ────────────────────────────────────────────────────

  async _getMenuId(cafeId) {
    const rawUrl = this.cafeUrl.startsWith('http') ? this.cafeUrl : `https://${this.cafeUrl}`;

    // 1) cafeUrl 경로에서 직접 추출: /menus/52
    const pathMatch = rawUrl.match(/\/menus\/(\d+)/);
    if (pathMatch) { this._log(`menuId 발견 (URL 경로): ${pathMatch[1]}`); return pathMatch[1]; }

    // 2) cafeUrl 쿼리 파라미터에서 추출: ?menuId=52
    const queryMatch = rawUrl.match(/[?&]menuId=(\d+)/i);
    if (queryMatch) { this._log(`menuId 발견 (URL 쿼리): ${queryMatch[1]}`); return queryMatch[1]; }

    this._log(`게시판 컨텍스트 페이지 이동: ${rawUrl}`);
    await this.page.goto(rawUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.waitForTimeout(1500);

    // 3) ca-fe 프레임 URL에서 menuId 탐색
    for (const f of this.page.frames()) {
      const m = f.url().match(/[?&](?:menuId|menuid)=(\d+)/i);
      if (m) { this._log(`menuId 발견 (프레임 URL): ${m[1]}`); return m[1]; }
    }

    // 2) 페이지 내 앵커·스크립트에서 menuId 탐색
    const menuId = await this.page.evaluate((cid) => {
      for (const a of document.querySelectorAll('a[href]')) {
        const m = a.href.match(/[?&]menuId=(\d+)/i);
        if (m) return m[1];
      }
      for (const s of document.querySelectorAll('script')) {
        const m = s.textContent.match(/["']?menuId["']?\s*[=:]\s*["']?(\d+)["']?/i);
        if (m) return m[1];
      }
      return null;
    }, cafeId);

    if (menuId) { this._log(`menuId 발견 (DOM): ${menuId}`); return menuId; }

    this._log('menuId를 찾지 못했습니다 — 기본 write URL 사용');
    return null;
  }

  // ─── ca-fe 프레임 + SmartEditor 초기화 대기 ───────────────────────────────

  async _waitForEditor() {
    this._log('글쓰기 에디터 로딩 대기');

    // ca-fe 프레임 대기
    let frame;
    for (let i = 0; i < 30; i++) {
      frame = this.page.frames().find(f => f.url().includes('ca-fe'));
      if (frame) {
        try {
          await frame.waitForSelector('.WritingWrap', { timeout: 2000 });
          break;
        } catch { /* 계속 대기 */ }
      }
      await this.page.waitForTimeout(500);
    }
    if (!frame) throw new Error('카페 글쓰기 프레임 로딩 시간 초과');

    // SmartEditor ONE 초기화 대기 — 에디터 ID 동적 탐색
    const editorIdHandle = await frame.waitForFunction(
      () => {
        const se = window.SmartEditor;
        if (!se || !se._editors) return null;
        const keys = Object.keys(se._editors);
        if (keys.length === 0) return null;
        // 에디터가 getDocumentData를 가지는지 확인
        const ed = se.getEditor(keys[0]);
        return (ed && typeof ed.getDocumentData === 'function') ? keys[0] : null;
      },
      { timeout: 20000 },
    );
    this._editorId = await editorIdHandle.jsonValue();
    this._log(`에디터 준비 완료 (ID: ${this._editorId})`);
    return frame;
  }

  // ─── 게시판 선택 ───────────────────────────────────────────────────────────

  async _selectBoard(frame) {
    if (!this.boardName) return;
    this._log(`게시판 선택: ${this.boardName}`);

    // "부모 >> 자식" 또는 "부모 / 자식" 형식 파싱 — 마지막 세그먼트가 실제 클릭할 리프 게시판
    const sep = this.boardName.includes(' >> ') ? ' >> ' : ' / ';
    const parts = this.boardName.split(sep).map(p => p.trim()).filter(p => p);
    const leafName = parts[parts.length - 1];
    const parentName = parts.length > 1 ? parts[parts.length - 2] : null;

    try {
      await frame.click('.FormSelectButton .button', { timeout: 5000 });
      await frame.waitForSelector('.option_list', { state: 'visible', timeout: 5000 });
      await frame.waitForTimeout(300);

      const allOpts = frame.locator('.option_list .option, .option_list li');
      const total = await allOpts.count();
      let found = false;

      for (let i = 0; i < total; i++) {
        const text = (await allOpts.nth(i).innerText()).trim();

        // 리프 게시판 이름 완전 일치
        if (text === leafName) {
          await allOpts.nth(i).click();
          await frame.waitForTimeout(500);
          this._log(`게시판 선택 완료: ${text}`);
          found = true;
          break;
        }
      }

      // 완전 일치 실패 → 리프 이름 포함 여부로 재시도 (부모 이름도 확인)
      if (!found) {
        for (let i = 0; i < total; i++) {
          const text = (await allOpts.nth(i).innerText()).trim();
          const isLeaf = text.includes(leafName);
          const isUnderParent = !parentName || (() => {
            // 바로 위 항목(그룹 헤더)에 parentName 포함 여부 확인
            return i === 0 ? false : true; // 헤더 파악이 어려우므로 리프 매칭만으로 진행
          })();
          if (isLeaf && isUnderParent) {
            await allOpts.nth(i).click();
            await frame.waitForTimeout(500);
            this._log(`게시판 부분 일치 선택: ${text}`);
            found = true;
            break;
          }
        }
      }

      if (!found) {
        this._log(`게시판 "${this.boardName}" 를 찾지 못했습니다 — Escape 후 기본 게시판 사용`);
        await frame.keyboard.press('Escape').catch(() => {});
        await frame.waitForTimeout(800); // 드롭다운 닫힘 대기
      }
    } catch (e) {
      this._log(`게시판 선택 오류: ${e.message}`);
      await frame.keyboard.press('Escape').catch(() => {});
      await frame.waitForTimeout(800);
    }
  }

  // ─── 제목 입력 ─────────────────────────────────────────────────────────────

  async _fillTitle(frame, title) {
    this._log('제목 입력');
    const titleEl = await frame.waitForSelector(
      '.FlexableTextArea textarea, .FlexableTextArea .textarea_input, textarea[placeholder*="제목"]',
      { timeout: 10000 },
    );
    await titleEl.click();
    await titleEl.fill(title);
    this._log('제목 입력 완료');
  }

  // ─── 본문 입력 (SmartEditor ONE setDocumentData) ───────────────────────────

  async _fillContent(frame, htmlContent) {
    this._log('본문 입력 시작');

    const ok = await frame.evaluate(
      ({ html, editorId }) => {
        try {
          const ed = window.SmartEditor.getEditor(editorId);
          if (!ed) return { ok: false, reason: 'editor not found' };

          const currentDoc = ed.getDocumentData();
          const doc = currentDoc.document;

          // HTML → 단락 배열로 변환
          const parser = new DOMParser();
          const parsed = parser.parseFromString(html, 'text/html');
          let paragraphs = Array.from(
            parsed.querySelectorAll('p, h1, h2, h3, h4, li'),
          ).map(el => el.textContent.trim()).filter(t => t);

          if (paragraphs.length === 0) {
            const text = parsed.body.innerHTML
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<[^>]+>/g, '')
              .trim();
            paragraphs = text.split('\n').map(t => t.trim()).filter(t => t);
          }
          if (paragraphs.length === 0) paragraphs = [parsed.body.textContent.trim() || ''];

          // SmartEditor ONE JSON 포맷으로 변환
          const components = paragraphs.map((text, idx) => ({
            id: `SE-c${idx}-${Date.now()}`,
            layout: 'default',
            '@ctype': 'text',
            value: [{
              id: `SE-p${idx}-${Date.now()}`,
              '@ctype': 'paragraph',
              nodes: [{
                id: `SE-n${idx}-${Date.now()}`,
                '@ctype': 'textNode',
                value: text,
              }],
            }],
          }));

          ed.setDocumentData({
            document: {
              version: doc.version,
              theme: doc.theme,
              language: doc.language,
              id: doc.id,
              components,
              di: doc.di,
            },
            documentId: currentDoc.documentId,
          });

          return { ok: true, paragraphCount: paragraphs.length };
        } catch (e) {
          return { ok: false, reason: e.message };
        }
      },
      { html: htmlContent, editorId: this._editorId || SE_EDITOR_ID_FALLBACK },
    );

    if (ok.ok) {
      this._log(`본문 입력 완료 (${ok.paragraphCount}개 단락, SmartEditor API)`);
    } else {
      this._log(`본문 API 실패: ${ok.reason} — DOM 직접 삽입 시도`);
      // 폴백: se-content DOM 삽입
      await frame.evaluate((html) => {
        const el = document.querySelector('.se-content');
        if (el) {
          el.innerHTML = `<div class="se-component se-text se-l-default"><div class="se-section-content">${html}</div></div>`;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, htmlContent);
      this._log('본문 입력 완료 (DOM 폴백)');
    }
  }

  // ─── 등록 버튼 클릭 ────────────────────────────────────────────────────────

  async _submit(frame) {
    this._log('등록 버튼 클릭');
    for (const sel of [
      'a.BaseButton--skinGreen',
      '.WritingHeader a.BaseButton',
      'a:has-text("등록")',
      'button:has-text("등록")',
    ]) {
      try {
        await frame.click(sel, { timeout: 5000 });
        this._log(`등록 클릭 완료 (${sel})`);
        return;
      } catch { /* 다음 시도 */ }
    }
    throw new Error('등록 버튼을 찾을 수 없습니다.');
  }

  // ─── 공개 메서드: 포스팅 실행 ──────────────────────────────────────────────

  async post({ title, htmlContent }) {
    const cafeId = await this._getCafeId();

    // cafeUrl에서 게시판 menuId 추출 → write URL에 포함시켜 게시판 자동 선택
    const menuId = await this._getMenuId(cafeId);
    const writeUrl = menuId
      ? `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/write?menuId=${menuId}`
      : `https://cafe.naver.com/f-e/cafes/${cafeId}/articles/write`;

    this._log(`글쓰기 페이지 이동: ${writeUrl}`);
    await this.page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const frame = await this._waitForEditor();

    // menuId가 URL에 포함되면 게시판이 자동 선택되므로 드롭다운 조작 생략
    if (!menuId && this.boardName) {
      await this._selectBoard(frame);
    }
    await this._fillTitle(frame, title);
    await this._fillContent(frame, htmlContent);
    await this.page.waitForTimeout(1000); // 에디터 반영 대기
    await this._submit(frame);

    // 제출 후 ca-fe 프레임 URL 변경 폴링 (SPA 내비게이션)
    this._log('게시 완료 대기');
    let postedUrl = writeUrl;
    for (let i = 0; i < 60; i++) {
      await this.page.waitForTimeout(500);
      const cafeFrame2 = this.page.frames().find(f => f.url().includes('ca-fe'));
      if (!cafeFrame2) continue;
      const url = cafeFrame2.url();
      if (url.includes('/articles/') && !url.includes('/write')) {
        postedUrl = url;
        break;
      }
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
