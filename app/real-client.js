// RealClient — browser ⇄ local Bun backend (/ws) ⇄ omo app-server. Same contract as MockClient.
// JS twin of src/session-client.ts so the prototype runs without a build step.
export class RealClient {
  constructor(opts = {}) {
    this.opts = opts;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.ls = { notification: new Set(), serverRequest: new Set(), connection: new Set() };
    this.attempt = 0;
    this.everOpened = false;
    this.closedByUser = false;
    this.timer = null;
    this.serverInfo = null;
    const hdr = () => (opts.sessionKey ? { 'x-mc-key': opts.sessionKey } : {});
    const api = (p) => new URL(p, location.href).href;
    this.backend = {
      listSkills: async () => {
        const r = await fetch(api('api/skills'), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Saved-session history read from the session file by the backend; unlike thread/read it does not load the session.
      history: async (threadId) => {
        const r = await fetch(api(`api/threads/${encodeURIComponent(threadId)}/history`), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Thread id → last conversation time (ms) from each session file; app-server's updatedAt also moves on metadata.
      activity: async () => {
        const r = await fetch(api('api/threads/activity'), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Subagent runs and context usage read from the session file → { agents, usage }; app-server sends neither.
      meta: async (threadId) => {
        const r = await fetch(api(`api/threads/${encodeURIComponent(threadId)}/meta`), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // A pasted image, saved by the backend → { path, url }. app-server's turn input takes no image items.
      upload: async (file) => {
        const r = await fetch(api('api/uploads'), { method: 'POST', headers: { ...hdr(), 'content-type': file.type }, body: file });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Models of extension-registered providers (Claude subscription) that model/list does not return.
      extraModels: async () => {
        const r = await fetch(api('api/models/extra'), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Questions and approvals reach only subscribed connections, so the dashboard relays each one to the backend's Web
      // Push; the backend drops the repeats that other open dashboards send.
      pushRequest: async (body) => {
        const r = await fetch(api('api/push/request'), { method: 'POST', headers: { ...hdr(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      restoreTodos: async (threadId) => {
        const r = await fetch(api(`api/threads/${encodeURIComponent(threadId)}/restore-todos`), { method: 'POST', headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      // Plan usage of the Claude and ChatGPT logins omo uses → { checkedAt, accounts: [{ provider, name, plan, windows, error? }] }.
      usage: async () => {
        const r = await fetch(api('api/usage'), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      omoVersion: async () => {
        const r = await fetch(api('api/omo/version'), { headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
      omoUpdate: async () => {
        const r = await fetch(api('api/omo/update'), { method: 'POST', headers: hdr() });
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      },
    };
  }
  on(ev, cb) { this.ls[ev].add(cb); return () => this.ls[ev].delete(cb); }
  emit(ev, p) { for (const f of [...this.ls[ev]]) { try { f(p); } catch (e) { console.error(e); } } }

  connect() {
    this.closedByUser = false;
    return new Promise((resolve) => { this.onFirstOpen = resolve; this.open(); });
  }
  open() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const base = this.opts.url || `${proto}://${location.host}/ws`;
    const url = this.opts.sessionKey ? `${base}?key=${encodeURIComponent(this.opts.sessionKey)}` : base;
    this.emit('connection', { state: this.everOpened ? 'reconnecting' : 'connecting', attempt: this.attempt, firstConnect: !this.everOpened });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => {
      try {
        const init = await this.request('initialize', { clientInfo: { name: 'omonitor', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        this.serverInfo = init?.serverInfo || null;
        this.userAgent = init?.userAgent || '';
        const reconnected = this.everOpened;
        this.everOpened = true;
        this.attempt = 0;
        this.emit('connection', { state: 'open', reconnected });
        if (this.onFirstOpen) { this.onFirstOpen(); this.onFirstOpen = null; }
      } catch { try { ws.close(); } catch {} }
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = (ev) => {
      for (const p of this.pending.values()) p.reject({ code: -32000, message: `연결이 끊겨 ${p.method} 요청이 취소되었습니다` });
      this.pending.clear();
      if (this.ws !== ws) return;
      if (this.closedByUser) { this.emit('connection', { state: 'closed' }); return; }
      this.lastCloseReason = ev.reason || '';
      this.scheduleReconnect();
    };
  }
  scheduleReconnect() {
    this.attempt++;
    const retryInMs = Math.min(this.opts.maxBackoffMs || 15000, 500 * 2 ** this.attempt);
    this.emit('connection', { state: 'reconnecting', attempt: this.attempt, retryInMs, firstConnect: !this.everOpened, reason: this.lastCloseReason });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshKey().then(() => this.open()), retryInMs);
  }
  reconnectNow() { clearTimeout(this.timer); this.timer = null; if (!this.ws || this.ws.readyState > 1) this.refreshKey().then(() => this.open()); }
  // The backend issues a new session key on every start, so a reconnect after a restart asks for it again.
  async refreshKey() {
    if (!this.opts.sessionKey) return;
    try {
      const r = await fetch(new URL('api/config', location.href).href, { cache: 'no-store' });
      const cfg = r.ok ? await r.json() : null;
      if (cfg?.key) this.opts.sessionKey = cfg.key;
    } catch {}
  }
  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if ('error' in msg) p.reject(msg.error); else p.resolve(msg.result);
    } else if (hasId && typeof msg.method === 'string') this.emit('serverRequest', msg);
    else if (typeof msg.method === 'string') this.emit('notification', msg);
  }
  request(method, params) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject({ code: -32000, message: 'app-server에 연결되어 있지 않습니다' });
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  respond(id, result) { this.ws?.send(JSON.stringify({ id, result })); }
  close() { this.closedByUser = true; clearTimeout(this.timer); this.ws?.close(); }
  // demo hooks are mock-only
  setSpeed() {}
  simulateDisconnect() {}
}
