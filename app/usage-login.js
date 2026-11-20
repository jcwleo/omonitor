// mc-usage-login: the 구독 계정 dialog (a bottom sheet on phones). It shows omonitor's own Claude and ChatGPT logins,
// the ones the header's plan usage reads with, and runs a browser login: start it, open the authorization page from a
// tap (a page opened after an await would be blocked as a popup), then ChatGPT's local callback on this Mac or a pasted
// Claude code / ChatGPT redirect URL finishes it. It polls only while a login is pending and the dialog is open, and
// never sees a token. The host opens it with show({ backend, onAuth, onClose }).
const PROVIDERS = [['claude', 'Claude'], ['chatgpt', 'ChatGPT']];
const POLL_MS = 2000;
const COARSE = matchMedia('(pointer: coarse)').matches;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const live = (f) => f.status === 'pending' || f.status === 'exchanging';
const left = (at) => { const m = Math.ceil((at - Date.now()) / 60000); return m > 1 ? `${m}분 남음` : '1분 안에 만료'; };
const message = (e) => (e instanceof TypeError ? 'omonitor 서버에 연결하지 못했습니다' : e.message);
const hostOf = (url) => { try { return new URL(url).host; } catch (e) { if (e instanceof TypeError) return ''; throw e; } };
const svg = (d, size = 16) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const ICON = {
  close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 18),
  out: svg('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>', 15),
  more: svg('<path d="m9 6 6 6-6 6"/>', 14),
};

const CSS = `
:host{display:contents}
*{box-sizing:border-box}
[hidden]{display:none!important}
dialog{position:fixed;inset:0 auto auto 0;width:100%;height:var(--app-h,100dvh);max-width:none;max-height:none;margin:0;padding:clamp(12px,12vh,108px) 12px 12px;border:0;background:transparent;color:var(--fg);font-family:var(--font-ui);transform:var(--app-shift,none);display:flex;align-items:flex-start;justify-content:center;overflow:hidden}
dialog:not([open]){display:none}
dialog::backdrop{background:rgba(0,0,0,.5);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);animation:fade 120ms ease-out}
.surface{width:min(480px,100%);max-height:min(720px,100%);display:flex;flex-direction:column;background:var(--bg2);border:1px solid var(--line2);border-radius:var(--r-lg);box-shadow:var(--shadow-lg);overflow:hidden;animation:pop var(--dur) var(--ease-out)}
header{flex:none;display:flex;align-items:center;padding:9px 7px 6px 13px;border-bottom:1px solid var(--line-soft)}
h2{margin:0;font:600 18px var(--font-ui);outline:none}
.body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:8px;padding:10px 13px 14px}
.acct{display:flex;flex-direction:column;gap:9px;padding:10px 12px 12px;border-radius:var(--r);background:var(--tint)}
.head{display:flex;align-items:center;gap:8px;min-height:36px}
.name{font-size:14.5px;font-weight:600}
.pill{flex:none;font-size:12px;font-weight:500;padding:2px 8px;border-radius:999px;background:var(--sel);color:var(--fg2)}
.pill.on{background:var(--acc-tint);color:var(--acc-fg)}
.pill.wait{background:color-mix(in oklab,var(--warn) 15%,transparent);color:color-mix(in oklab,var(--warn) 70%,var(--fg))}
.pill.bad{background:color-mix(in oklab,var(--err) 15%,transparent);color:color-mix(in oklab,var(--err) 70%,var(--fg))}
.time{font-size:12px;color:var(--fg2);font-variant-numeric:tabular-nums;white-space:nowrap}
.act{margin-left:auto;display:flex}
.email{margin:-6px 0 0;font-size:13px;color:var(--fg2);overflow-wrap:anywhere;user-select:text}
p{margin:0;font-size:13px;line-height:1.5;color:var(--fg2);word-break:keep-all;overflow-wrap:anywhere;text-wrap:pretty}
.small{font-size:12px;color:var(--fg2)}
.err{color:var(--err-fg)}
.row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.end{justify-content:flex-end}
.confirm{display:flex;flex-direction:column;gap:8px}
.wait{display:flex;align-items:center;gap:7px}
.dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--warn);animation:pulse 1.2s infinite}
.btn{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 12px;border:1px solid var(--color-divider);border-radius:var(--r-md);background:color-mix(in srgb,var(--color-text) 4%,transparent);color:var(--fg);font-size:13.5px;font-weight:500;white-space:nowrap}
.btn:hover{background:color-mix(in srgb,var(--color-text) 7%,transparent)}
.btn:active{background:color-mix(in srgb,var(--color-text) 14%,transparent);scale:.96}
.btn.primary{background:var(--color-accent);border-color:var(--color-accent);color:var(--on-acc)}
.btn.primary:hover{background:var(--color-accent-600)}
.btn.primary:active{background:color-mix(in srgb,var(--color-accent) 80%,black)}
.btn.danger{background:var(--err);border-color:var(--err);color:var(--on-acc)}
.btn.danger:hover{background:color-mix(in srgb,var(--err) 88%,black)}
.btn.danger:active{background:color-mix(in srgb,var(--err) 76%,black)}
.btn:disabled,.btn[aria-disabled=true]{opacity:.45;cursor:not-allowed;scale:none}
.icon{all:unset;cursor:pointer;margin-left:auto;width:40px;height:40px;display:grid;place-items:center;border-radius:var(--r-md);color:var(--fg2)}
.icon:hover{background:var(--hover);color:var(--fg)}
.icon:active{background:var(--sel)}
.more{all:unset;cursor:pointer;align-self:flex-start;display:inline-flex;align-items:center;gap:4px;min-height:32px;font-size:12.5px;color:var(--acc-fg)}
.more:hover{background:var(--hover)}
.more:active{background:var(--sel)}
.more svg{transition:rotate var(--dur) var(--ease-out)}
.more[aria-expanded=true] svg{rotate:90deg}
.btn:focus-visible,.icon:focus-visible,.more:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
form{display:flex;flex-direction:column;gap:6px}
label{font-size:12px;color:var(--fg2)}
input{flex:1;min-width:0;min-height:36px;padding:6px 10px;font:13.5px var(--mono);color:var(--fg);caret-color:var(--acc);background:var(--color-surface);border:1px solid var(--color-divider);border-radius:var(--r-md);outline:none;text-overflow:ellipsis}
input::placeholder{color:var(--fg2)}
input:hover{border-color:var(--fg2)}
input:focus-visible{border-color:var(--acc);box-shadow:0 0 0 3px color-mix(in srgb,var(--acc) 25%,transparent)}
input[aria-invalid=true]{border-color:var(--err-line)}
.field{flex-wrap:nowrap}
.note{margin:4px 2px 0;font-size:12.5px;color:var(--fg2)}
code{font:12px var(--mono);color:var(--fg2);white-space:nowrap}
@keyframes pop{from{opacity:0;scale:.97}}
@keyframes sheet{from{translate:0 100%}}
@keyframes fade{from{opacity:0}}
@keyframes pulse{0%,100%{opacity:.45}50%{opacity:.9}}
@media (max-width:699px){
  dialog{align-items:flex-end;padding:max(12px,env(safe-area-inset-top)) 0 0}
  .surface{width:100%;max-height:100%;border-width:1px 0 0;border-radius:var(--r-lg) var(--r-lg) 0 0;animation:sheet var(--dur-slow) var(--ease-out)}
  .body{padding-bottom:max(14px,env(safe-area-inset-bottom))}
  .btn,.icon{min-height:44px;min-width:44px}
  .more{min-height:44px}
  input{min-height:44px;font-size:16px}
}
@media (prefers-reduced-motion:reduce){@keyframes pop{from{opacity:0}}@keyframes sheet{from{opacity:0}}.btn:active{scale:none;opacity:.75}.more svg{transition:none}}
`;

class McUsageLogin extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' }).innerHTML = `<style>${CSS}</style>
      <dialog aria-labelledby="t"><div class="surface">
        <header><h2 id="t" tabindex="-1" autofocus>구독 계정</h2><button type="button" class="icon" data-act="close" aria-label="닫기" title="닫기 (Esc)">${ICON.close}</button></header>
        <div class="body">
          <div class="row" data-load role="alert" hidden><p class="err"></p><button type="button" class="btn" data-act="reload">다시 시도</button></div>
          ${PROVIDERS.map(([p]) => `<section class="acct" data-provider="${p}" aria-labelledby="n-${p}"></section>`).join('')}
          <p class="note">사용량 조회용 로그인입니다. opencode·Codex&nbsp;로그인과 별도로 <code>~/.omonitor/usage-auth</code>에 저장합니다. 로그아웃하면 omonitor&nbsp;인증만 지웁니다.</p>
        </div></div></dialog>`;
    this.dialog = this.shadowRoot.querySelector('dialog');
    this.ui = { busy: {}, errors: {}, confirm: null, opened: new Set(), manual: new Set(), drafts: {} };
    this.html = {};
    this.shadowRoot.addEventListener('click', (e) => this.onClick(e));
    this.shadowRoot.addEventListener('submit', (e) => { e.preventDefault(); this.complete(e.target.closest('[data-provider]').dataset.provider); });
    this.shadowRoot.addEventListener('input', (e) => {
      const p = e.target.closest('[data-provider]')?.dataset.provider, f = p && this.flow(p);
      if (f) { this.ui.drafts[f.id] = e.target.value; this.syncSubmit(p); }
    });
    this.dialog.addEventListener('cancel', (e) => { e.preventDefault(); this.close(); });
    // Outside the surface closes, unless the press started inside (a text selection dragged out of the field).
    this.dialog.addEventListener('pointerdown', (e) => { this.downOutside = e.target === this.dialog; });
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog && this.downOutside) this.close(); });
    this.onVisible = () => { if (document.visibilityState === 'visible' && this.timer) this.refresh(); };
  }
  show({ backend, onAuth, onClose }) {
    Object.assign(this, { backend, onAuth, onClose, shown: true });
    document.addEventListener('visibilitychange', this.onVisible);
    this.render();
    this.dialog.showModal();
    this.refresh();
  }
  disconnectedCallback() { clearTimeout(this.timer); document.removeEventListener('visibilitychange', this.onVisible); }
  // The latest login of a provider that is still to act on; a finished one stays listed until the next start.
  flow(p) { return this.auth?.pending.findLast((f) => f.provider === p && f.status !== 'complete') || null; }
  async refresh() {
    const seq = this.seq = (this.seq || 0) + 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.loading = true;
    this.render();
    try {
      const auth = await this.backend.usageAuth();
      if (seq !== this.seq || !this.isConnected) return;
      Object.assign(this, { auth, loadError: '' });
      this.onAuth?.(auth);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      if (seq !== this.seq || !this.isConnected) return;
      this.loadError = message(e);
    }
    this.loading = false;
    this.render();
    // Only while a login waits, until its expiry has passed (the backend marks it failed then).
    const until = Math.max(0, ...(this.auth?.pending || []).filter(live).map((f) => f.expiresAt + 5000));
    if (!this.closing && Date.now() < until) this.timer = setTimeout(() => this.refresh(), POLL_MS);
  }
  async act(p, kind, run) {
    if (this.ui.busy[p]) return;
    this.ui.busy[p] = kind;
    this.ui.errors[p] = '';
    this.render();
    try { await run(); } catch (e) {
      if (!(e instanceof Error)) throw e;
      this.ui.errors[p] = message(e);
    }
    delete this.ui.busy[p];
    this.ui.confirm = null;
    await this.refresh();
  }
  complete(p) {
    const f = this.flow(p), input = (f && this.ui.drafts[f.id] || '').trim();
    if (!f || !input || this.ui.busy[p]) return;
    this.act(p, 'complete', async () => { await this.backend.usageComplete(p, f.id, input); delete this.ui.drafts[f.id]; });
  }
  onClick(e) {
    const el = e.target.closest('[data-act]');
    if (el?.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    const p = el?.closest('[data-provider]')?.dataset.provider, f = p && this.flow(p);
    switch (el?.dataset.act) {
      case 'close': return this.close();
      case 'reload': return !this.loading && this.refresh();
      case 'start': return this.act(p, 'start', () => this.backend.usageLogin(p));
      case 'cancel': case 'dismiss': return f && this.act(p, el.dataset.act, () => this.backend.usageCancel(p, f.id));
      case 'logout': return this.act(p, 'logout', () => this.backend.usageLogout(p));
      case 'ask-logout': this.ui.confirm = p; this.render(); return this.shadowRoot.querySelector(`[data-provider="${p}"] [data-act="keep"]`)?.focus();
      case 'keep': this.ui.confirm = null; this.render(); return this.shadowRoot.querySelector(`[data-provider="${p}"] [data-act="ask-logout"]`)?.focus();
      case 'manual': if (f) this.ui.manual[this.ui.manual.has(f.id) ? 'delete' : 'add'](f.id); return this.render();
      case 'open':
        // Let the link open first: rebuilding the card now would drop the anchor before its navigation starts.
        if (f) this.ui.opened.add(f.id);
        return setTimeout(() => { this.render(); if (!COARSE) this.shadowRoot.querySelector(`[data-provider="${p}"] input`)?.focus(); });
      default:
    }
  }
  async close() {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.timer);
    const phone = matchMedia('(max-width: 699px)').matches, reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const surface = this.shadowRoot.querySelector('.surface');
    const opts = { duration: phone ? 200 : 120, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' };
    const computed = getComputedStyle(surface);
    const from = { opacity: computed.opacity, scale: computed.scale, translate: computed.translate };
    const backdropOpacity = getComputedStyle(this.dialog, '::backdrop').opacity;
    surface.style.animation = 'none';
    await Promise.allSettled([
      surface.animate([from, reduce ? { ...from, opacity: 0 } : phone ? { ...from, translate: '0 100%' } : { ...from, opacity: 0, scale: .97 }], opts).finished,
      this.dialog.animate({ opacity: [backdropOpacity, 0] }, { ...opts, pseudoElement: '::backdrop' }).finished,
    ]);
    this.dialog.close();
    this.onClose?.();
  }
  syncSubmit(p) {
    const f = this.flow(p), btn = this.shadowRoot.querySelector(`[data-provider="${p}"] [type="submit"]`);
    if (btn && f) { btn.disabled = !(this.ui.drafts[f.id] || '').trim(); btn.setAttribute('aria-disabled', String(!!this.ui.busy[p])); }
  }
  // A card is rebuilt only when its markup changes, so polling never drops focus, a typed draft or a hover.
  render() {
    const load = this.shadowRoot.querySelector('[data-load]');
    if (!this.loadError && load.contains(this.shadowRoot.activeElement)) this.shadowRoot.querySelector('h2').focus();
    load.hidden = !this.loadError;
    load.querySelector('p').textContent = this.loadError ? `계정 상태를 읽지 못했습니다. ${this.loadError}` : '';
    load.querySelector('button').textContent = this.loading ? '확인 중…' : '다시 시도';
    load.querySelector('button').setAttribute('aria-disabled', String(!!this.loading));
    for (const [p, label] of PROVIDERS) {
      const card = this.shadowRoot.querySelector(`[data-provider="${p}"]`), f = this.flow(p);
      const html = this.card(p, label, f);
      if (this.html[p] !== html) {
        const active = this.shadowRoot.activeElement;
        const focus = card.contains(active) && (active.dataset.act || active.tagName);
        const selection = focus === 'INPUT' ? [active.selectionStart, active.selectionEnd] : null;
        card.innerHTML = this.html[p] = html;
        const input = card.querySelector('input');
        if (input && f) input.value = this.ui.drafts[f.id] || '';
        if (focus) {
          const next = card.querySelector(focus === 'INPUT' ? 'input' : focus === 'BUTTON' ? '[type="submit"]' : `[data-act="${focus}"]`) || card.querySelector('.act button, input, a');
          next?.focus({ preventScroll: true });
          if (selection && next === input) input.setSelectionRange(...selection);
        }
      }
      const time = card.querySelector('[data-time]');
      if (time && f && time.textContent !== left(f.expiresAt)) time.textContent = left(f.expiresAt);
      this.syncSubmit(p);
    }
  }
  card(p, label, f) {
    const a = this.auth?.accounts.find((x) => x.provider === p), busy = this.ui.busy[p], err = this.ui.errors[p];
    const state = !this.auth ? 'loading' : f && (f.status === 'error' || f.expiresAt <= Date.now()) ? 'error' : f ? f.status : this.ui.confirm === p ? 'confirm' : a?.connected ? 'on' : 'off';
    const button = (act, text, cls = '', aria = `${label} ${text}`) => `<button type="button" class="btn ${cls}" data-act="${act}" aria-label="${esc(aria)}" aria-disabled="${!!busy}">${text}</button>`;
    const [pill, tone, action] = {
      loading: [this.loadError ? '확인 불가' : '확인 중', '', ''],
      off: ['연결 안 됨', '', button('start', busy === 'start' ? '준비 중…' : '로그인', 'primary')],
      on: ['연결됨', 'on', button('ask-logout', '로그아웃')],
      confirm: ['연결됨', 'on', ''],
      pending: ['로그인 중', 'wait', button('cancel', busy === 'cancel' ? '취소 중…' : '취소', '', `${label} 로그인 취소`)],
      exchanging: ['연결 중', 'wait', button('cancel', busy === 'cancel' ? '취소 중…' : '취소', '', `${label} 로그인 취소`)],
      error: [a?.connected ? '연결됨' : '오류', a?.connected ? 'on' : 'bad', button('start', busy === 'start' ? '준비 중…' : '다시 로그인', 'primary')],
    }[state];
    const head = `<div class="head"><span class="name" id="n-${p}">${label}</span><span class="pill ${tone}" role="status">${pill}</span>${state === 'pending' ? '<span class="time" data-time></span>' : ''}<span class="act">${action}</span></div>`;
    const email = a?.connected && a.email && (state === 'on' || state === 'confirm') ? `<p class="email">${esc(a.email)}</p>` : '';
    const errLine = err && state !== 'error' && !(state === 'pending' && this.paste(f)) ? `<p class="err" role="alert">${esc(err)}</p>` : '';
    const body = {
      confirm: () => `<div class="confirm" data-confirm role="group" aria-label="${label} 로그아웃 확인"><p>이 Mac의 omonitor에 저장된 ${label} 로그인을 지웁니다. 사용량을 다시 보려면 로그인해야 합니다.</p>
        <div class="row end">${button('keep', '취소', '', '로그아웃 취소')}${button('logout', busy === 'logout' ? '로그아웃 중…' : '로그아웃', 'danger')}</div></div>`,
      pending: () => this.pending(p, label, f, err),
      exchanging: () => '<p class="wait"><span class="dot"></span>토큰을 받는 중입니다.</p>',
      error: () => `<p class="err" role="alert">${esc(f.status === 'error' && f.error || '로그인 요청이 만료됐습니다. 다시 로그인하세요')}</p><div class="row">${button('dismiss', '닫기', '', `${label} 로그인 오류 닫기`)}</div>`,
    }[state]?.() || '';
    return head + email + body + errLine;
  }
  paste(f) { return f.mode === 'paste' || this.ui.manual.has(f.id); }
  pending(p, label, f, err) {
    const claude = p === 'claude', opened = this.ui.opened.has(f.id), manual = this.ui.manual.has(f.id);
    const link = `<div class="row"><a class="btn ${opened ? '' : 'primary'}" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer" data-act="open">로그인 페이지 열기${ICON.out}</a><span class="small">${esc(hostOf(f.url))}</span></div>
      <p class="small">승인 화면의 권한 목록이 사용량 조회보다 넓을 수 있지만 omonitor는&nbsp;사용량만&nbsp;읽습니다.</p>`;
    const form = `<form novalidate><label for="in-${p}">${claude ? '승인 코드' : '이동한 주소'}</label>
      <div class="row field"><input id="in-${p}" inputmode="${claude ? 'text' : 'url'}" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="${claude ? 'xxxxxxxx#xxxxxxxx' : 'http://localhost:1455/auth/callback?code=…'}" aria-describedby="${err ? `e-${p} ` : ''}h-${p}"${err ? ' aria-invalid="true"' : ''}>
      <button type="submit" class="btn ${opened || f.mode === 'callback' ? 'primary' : ''}">${this.ui.busy[p] === 'complete' ? '연결 중…' : '연결'}</button></div>
      <p class="small" id="h-${p}">${claude ? 'Claude 승인 페이지에 표시된 코드를 그대로 붙여넣으세요.' : `${f.mode === 'paste' ? '다른 앱이 포트 1455를 사용 중이라 자동 연결할 수 없습니다. ' : ''}로그인 후 localhost로 이동하면 페이지 내용과 관계없이 주소창의&nbsp;주소&nbsp;전체를 붙여넣으세요.`}</p>
      ${err ? `<p class="err" id="e-${p}" role="alert">${esc(err)}</p>` : ''}</form>`;
    if (f.mode === 'paste') return link + form;
    return `${link}<p class="wait"><span class="dot"></span>이 Mac의 브라우저에서 로그인을 마치면 자동으로 연결됩니다.</p>
      <button type="button" class="more" data-act="manual" aria-expanded="${manual}">${ICON.more}자동으로 연결되지 않으면 주소 붙여넣기</button>${manual ? form : ''}`;
  }
}

export function defineUsageLogin() {
  if (!customElements.get('mc-usage-login')) customElements.define('mc-usage-login', McUsageLogin);
}
