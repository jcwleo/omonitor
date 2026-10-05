import { installTextareaInputBridge } from './terminal-input.js';
import { installTerminalClipboard, stripTerminalExecutingTrailingLineBreaks } from './terminal-clipboard.js';
import { installInactiveTerminalReportGuards } from './terminal-reports.js';
import { terminalKeySequence, ctrlArmedOutcome } from './terminal-keys.js';

const base = new URL('../', import.meta.url);
const url = (path) => new URL(path, base);
const coarse = () => matchMedia('(pointer: coarse)').matches;
let libraries;
const loadLibraries = () => libraries ??= Promise.all([
  import(url('vendor/xterm.js').href), import(url('vendor/addon-fit.js').href),
]).catch((error) => { libraries = null; throw error; });

class McTerminal extends HTMLElement {
  static observedAttributes = ['session-id', 'cwd'];
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this.generation = 0;
    this.disposables = [];
    this.ready = false;
    this.ctrl = false;
    this.shadowRoot.innerHTML = `
      <link rel="stylesheet" href="${url('vendor/xterm.css')}">
      <link rel="stylesheet" href="${url('app/terminal.css')}">
      <section class="terminal">
        <header><span class="status" role="status">준비 중</span><span class="cwd"></span>
          <button type="button" data-action="start">터미널 시작</button>
          <button type="button" data-action="close" hidden>종료</button></header>
        <div class="screen"></div>
        <div class="empty">세션 작업 폴더에서 새 셸을 엽니다. 탭을 닫아도 셸은 유지됩니다.</div>
        <div class="keys" aria-label="터미널 보조키" hidden>
          <button type="button" data-action="ctrl" aria-pressed="false">Ctrl</button>
          <button type="button" data-key="escape">Esc</button>
          <button type="button" data-key="tab">Tab</button>
          <button type="button" data-key="arrowLeft" aria-label="왼쪽">←</button>
          <button type="button" data-key="arrowDown" aria-label="아래쪽">↓</button>
          <button type="button" data-key="arrowUp" aria-label="위쪽">↑</button>
          <button type="button" data-key="arrowRight" aria-label="오른쪽">→</button>
          <button type="button" data-key="enter">Enter</button>
          <button type="button" data-action="paste">붙여넣기</button>
        </div>
        <form class="paste" hidden>
          <label>터미널에 붙여넣기<textarea aria-label="터미널에 붙여넣기" rows="3" spellcheck="false"></textarea></label>
          <span>끝의 줄바꿈은 제거합니다. 실행하려면 Enter를 누르세요.</span>
          <div><button type="button" data-action="pasteCancel">취소</button><button type="submit">입력</button></div>
        </form>
        <div class="error" role="alert" hidden></div>
      </section>`;
    this.el = (selector) => this.shadowRoot.querySelector(selector);
    this.shadowRoot.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.key) {
        this.bridge?.reset();
        this.sendInput(terminalKeySequence(button.dataset.key));
        this.focusTerminal();
        return;
      }
      switch (button.dataset.action) {
        case 'start': void this.start(); break;
        case 'close': void this.closeTerminal(); break;
        case 'ctrl':
          this.ctrl = !this.ctrl;
          button.setAttribute('aria-pressed', String(this.ctrl));
          this.focusTerminal();
          break;
        case 'paste': this.el('.paste').hidden = false; this.el('.paste textarea').focus(); break;
        case 'pasteCancel': this.el('.paste').hidden = true; this.focusTerminal(); break;
      }
    });
    this.shadowRoot.addEventListener('pointerdown', (event) => {
      if (event.target.closest('.keys button') && event.target.dataset.action !== 'paste') event.preventDefault();
    });
    this.el('.paste').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = this.el('.paste textarea');
      this.bridge?.reset();
      this.xterm?.paste(stripTerminalExecutingTrailingLineBreaks(input.value));
      input.value = '';
      this.el('.paste').hidden = true;
      this.focusTerminal();
    });
    for (const type of ['keydown', 'keyup', 'keypress']) {
      this.shadowRoot.addEventListener(type, (event) => event.stopPropagation());
    }
  }
  connectedCallback() { this.initialize(); }
  disconnectedCallback() { this.dispose(); }
  attributeChangedCallback(_name, oldValue, newValue) {
    if (oldValue !== newValue && this.isConnected) this.initialize();
  }
  dispose() {
    this.generation++;
    this.ready = false;
    clearTimeout(this.reconnectTimer);
    cancelAnimationFrame(this.fitFrame);
    this.observer?.disconnect();
    if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null; }
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.bridge = null;
    this.xterm?.dispose();
    this.xterm = null;
    this.el('.screen').replaceChildren();
  }
  async refreshKey() {
    const response = await fetch(url('api/config'), { cache: 'no-store' });
    if (!response.ok) throw new Error('서버 연결을 확인하세요');
    return (await response.json()).key;
  }
  async api(method, query = '', body) {
    const response = await fetch(url(`api/terminal${query}`), {
      method, headers: { 'x-mc-key': this.key, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.status === 204 ? null : response.json();
  }
  status(text) { this.el('.status').textContent = text; }
  // Tells the dashboard whether this session has a shell, so the side panel widens only when there is one to show.
  live(on) {
    this.dispatchEvent(new CustomEvent('mc-terminal-live', { bubbles: true, detail: { sessionId: this.getAttribute('session-id'), live: on } }));
  }
  error(error) { this.el('.error').textContent = error?.message || String(error); this.el('.error').hidden = false; }
  async initialize() {
    this.dispose();
    const generation = this.generation;
    const sessionId = this.getAttribute('session-id');
    this.summary = null;
    this.ctrl = false;
    this.el('[data-action="ctrl"]').setAttribute('aria-pressed', 'false');
    this.el('.cwd').textContent = this.getAttribute('cwd') || '작업 폴더 없음';
    this.el('.error').hidden = true;
    this.el('.paste').hidden = true;
    this.el('.empty').hidden = false;
    this.el('.keys').hidden = true;
    this.el('[data-action="close"]').hidden = true;
    this.el('[data-action="start"]').hidden = false;
    this.el('[data-action="start"]').textContent = '터미널 시작';
    this.el('[data-action="start"]').disabled = true;
    this.status('확인 중');
    if (!sessionId) return;
    try {
      const key = await this.refreshKey();
      if (generation !== this.generation) return;
      this.key = key;
      const summary = await this.api('GET', `?sessionId=${encodeURIComponent(sessionId)}`);
      if (generation !== this.generation) return;
      this.summary = summary;
      if (summary) await this.mount(generation);
      else { this.status('시작 전'); this.live(false); }
    } catch (error) {
      if (generation === this.generation) { this.status('연결 오류'); this.error(error); }
    } finally {
      if (generation === this.generation) this.el('[data-action="start"]').disabled = false;
    }
  }
  async start() {
    const generation = this.generation;
    this.el('[data-action="start"]').disabled = true;
    this.el('.error').hidden = true;
    this.status('시작 중');
    try {
      this.key = await this.refreshKey();
      if (generation !== this.generation) return;
      if (this.summary) await this.api('DELETE', `?id=${encodeURIComponent(this.summary.id)}`);
      if (generation !== this.generation) return;
      const summary = await this.api('POST', '', {
        sessionId: this.getAttribute('session-id'), cwd: this.getAttribute('cwd'), cols: 80, rows: 24,
      });
      if (generation !== this.generation) return;
      this.summary = summary;
      await this.mount(generation);
    } catch (error) {
      if (generation === this.generation) { this.status('시작 실패'); this.error(error); }
    } finally {
      if (generation === this.generation) this.el('[data-action="start"]').disabled = false;
    }
  }
  async closeTerminal() {
    if (!this.summary || !confirm('터미널과 실행 중인 작업을 종료할까요?')) return;
    const generation = this.generation;
    const button = this.el('[data-action="close"]');
    button.disabled = true;
    try {
      this.key = await this.refreshKey();
      if (generation !== this.generation) return;
      await this.api('DELETE', `?id=${encodeURIComponent(this.summary.id)}`);
      if (generation === this.generation) await this.initialize();
    } catch (error) { if (generation === this.generation) this.error(error); }
    finally { button.disabled = false; }
  }
  async mount(generation) {
    const [{ Terminal }, { FitAddon }] = await loadLibraries();
    if (generation !== this.generation) return;
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    this.observer?.disconnect();
    this.xterm?.dispose();
    this.el('.screen').replaceChildren();
    this.xterm = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, Consolas, monospace',
      scrollback: 10000, disableStdin: true, macOptionClickForcesSelection: true,
      theme: { background: '#0a0d10', foreground: '#e2e8ee', cursor: '#5eead4', selectionBackground: '#1f3f45' },
    });
    this.fit = new FitAddon();
    this.xterm.loadAddon(this.fit);
    this.xterm.open(this.el('.screen'));
    this.xterm.textarea.setAttribute('aria-label', '터미널 입력');
    this.bridge = installTextareaInputBridge(this.xterm, (data) => this.sendInput(data));
    // Run before clipboard's capture handler, which may stopImmediatePropagation.
    // A paste bypasses the textarea mirror; later typing must not erase the pasted text.
    const resetAfterPaste = () => this.bridge?.reset();
    const terminalElement = this.xterm.element;
    terminalElement.addEventListener('paste', resetAfterPaste, true);
    this.disposables.push({ dispose: () => terminalElement.removeEventListener('paste', resetAfterPaste, true) });
    this.disposables.push(this.bridge, installTerminalClipboard(this.xterm),
      installInactiveTerminalReportGuards(this.xterm, () => this.ready && this.isConnected),
      this.xterm.onData((data) => this.sendInput(data)));
    this.live(true);
    this.el('.empty').hidden = true;
    this.el('.keys').hidden = false;
    this.el('[data-action="start"]').hidden = true;
    this.el('[data-action="close"]').hidden = false;
    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(this.el('.screen'));
    for (const link of this.shadowRoot.querySelectorAll('link')) link.onload = () => this.scheduleFit();
    let touchY = null, remainder = 0;
    const start = (event) => { touchY = event.touches.length === 1 ? event.touches[0].clientY : null; remainder = 0; };
    const move = (event) => {
      if (touchY === null || event.touches.length !== 1) return;
      const y = event.touches[0].clientY;
      remainder += touchY - y;
      touchY = y;
      const lines = Math.trunc(remainder / 16);
      if (lines) { this.xterm.scrollLines(lines); remainder -= lines * 16; }
      if (event.cancelable) event.preventDefault();
    };
    const screen = this.el('.screen');
    screen.addEventListener('touchstart', start, { passive: true });
    screen.addEventListener('touchmove', move, { passive: false });
    this.disposables.push({ dispose() { screen.removeEventListener('touchstart', start); screen.removeEventListener('touchmove', move); } });
    this.reconnectAttempt = 0;
    await this.connect(generation);
  }
  async connect(generation) {
    if (generation !== this.generation || !this.isConnected) return;
    this.ready = false;
    this.status(this.reconnectAttempt ? '재연결 중' : '연결 중');
    this.xterm.options.disableStdin = true;
    try {
      const key = await this.refreshKey();
      if (generation !== this.generation) return;
      const address = url('terminal-ws');
      address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      address.search = new URLSearchParams({ id: this.summary.id, key }).toString();
      const socket = this.socket = new WebSocket(address);
      socket.onmessage = (event) => {
        if (generation !== this.generation || socket !== this.socket) return;
        const message = JSON.parse(event.data);
        switch (message.type) {
          case 'snapshot':
            this.xterm.reset();
            this.xterm.write(message.data, () => {
              if (generation !== this.generation || socket !== this.socket) return;
              this.ready = this.summary.status === 'running';
              this.xterm.options.disableStdin = !this.ready;
              this.reconnectAttempt = 0;
              this.status(this.ready ? '연결됨' : '종료됨');
              this.scheduleFit();
              if (!coarse() && this.ready) this.focusTerminal();
            });
            break;
          case 'output': this.xterm.write(message.data); break;
          case 'exit':
            this.ready = false;
            this.summary.status = 'exited';
            this.xterm.options.disableStdin = true;
            this.status(`종료됨 (${message.exitCode})`);
            this.el('[data-action="start"]').textContent = '새 터미널';
            this.el('[data-action="start"]').hidden = false;
            socket.onclose = null;
            socket.close();
            break;
          case 'error': this.error(message.message); break;
        }
      };
      socket.onclose = async (event) => {
        if (generation !== this.generation) return;
        this.ready = false;
        this.xterm.options.disableStdin = true;
        if (event.code === 1008 || event.code === 1013) {
          this.status('연결 종료'); this.error(event.reason || '페이지를 새로고침해 다시 연결하세요'); return;
        }
        try {
          this.key = await this.refreshKey();
          if (generation !== this.generation) return;
          const summary = await this.api('GET', `?sessionId=${encodeURIComponent(this.getAttribute('session-id'))}`);
          if (generation !== this.generation) return;
          if (!summary || summary.id !== this.summary.id) {
            this.summary = null;
            this.status('터미널이 종료되었습니다');
            this.el('[data-action="start"]').textContent = '새 터미널';
            this.el('[data-action="start"]').hidden = false;
            return;
          }
          this.summary = summary;
        } catch (error) { if (generation === this.generation) this.error(error); }
        if (generation === this.generation) this.retry(generation);
      };
      socket.onerror = () => this.status('연결 오류');
    } catch (error) {
      if (generation === this.generation) { this.error(error); this.retry(generation); }
    }
  }
  retry(generation) {
    this.status('재연결 중');
    this.reconnectTimer = setTimeout(() => this.connect(generation), Math.min(30000, 1000 * 2 ** this.reconnectAttempt++));
  }
  scheduleFit() {
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      const rect = this.el('.screen').getBoundingClientRect();
      if (!this.xterm || rect.width < 30 || rect.height < 30) return;
      this.fit.fit();
      if (this.ready) this.socket.send(JSON.stringify({
        type: 'resize', cols: Math.min(500, Math.max(2, this.xterm.cols)), rows: Math.min(200, Math.max(2, this.xterm.rows)),
      }));
    });
  }
  focusTerminal() { this.xterm?.focus(); }
  sendInput(data) {
    if (!data || !this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    if (this.ctrl) {
      const outcome = ctrlArmedOutcome(data);
      if (outcome.kind !== 'passthrough') {
        this.ctrl = false;
        this.el('[data-action="ctrl"]').setAttribute('aria-pressed', 'false');
        if (outcome.kind === 'modified') data = outcome.data;
        this.bridge?.reset();
      }
    }
    this.socket.send(JSON.stringify({ type: 'input', data }));
  }
}

export function defineTerminal() {
  if (!customElements.get('mc-terminal')) customElements.define('mc-terminal', McTerminal);
}
