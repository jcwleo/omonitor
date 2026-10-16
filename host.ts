// omonitor ⇄ omo host. omo 5.1.34 (senpi 2026.10.15) removed the Codex-compatible `omo app-server`; integrations now
// drive the shared multi-session RPC host (`omo host`, senpi docs/rpc.md) over a local socket. The dashboard keeps
// speaking the app-server protocol to this backend, and HostBridge translates both ways over one host connection, so
// store.js and the simulator keep one contract.
import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readGoal, textOf, trashSession, type ArchiveStore, type SessionIndex, type SessionMeta } from './sessions.ts';

export const HOST_SOCKET = process.env.OMO_HOST_SOCKET || join(homedir(), '.omo/agent/rpc/rpc.sock');

export class HostError extends Error {
  constructor(message: string, readonly code?: string, readonly data?: unknown) {
    super(message);
  }
}
// Hosts set errorCode; older refusals carry the code as the error text or its prefix ("open_failed: ...").
const errorCode = (m: any): string | undefined => m.errorCode || String(m.error || '').match(/^([a-z_]+)(?::|$)/)?.[1];
export const engineOf = (v: unknown) => String(v || '').split('+')[0];

type Pending = { res: (v: any) => void; rej: (e: Error) => void; timer: ReturnType<typeof setTimeout>; type: string };

// One socket connection. Records are JSON split on LF only: readline would also split on U+2028/U+2029 inside strings.
class HostLink {
  #sock: Socket | null = null;
  #buf = '';
  #dec = new TextDecoder();
  #seq = 0;
  #pending = new Map<string, Pending>();
  #closed = false;
  constructor(readonly path: string, readonly onRecord: (m: any) => void, readonly onClose: () => void) {}

  open() {
    return new Promise<void>((res, rej) => {
      const sock = createConnection(this.path);
      const fail = (e: Error) => { sock.destroy(); rej(e); };
      sock.once('error', fail);
      sock.once('connect', () => {
        sock.off('error', fail);
        this.#sock = sock;
        sock.on('data', (chunk: Buffer) => this.#data(chunk));
        sock.on('error', () => this.#close());
        sock.on('close', () => this.#close());
        res();
      });
    });
  }

  request(type: string, params: Record<string, unknown> = {}, ms = 30_000): Promise<any> {
    const sock = this.#sock;
    if (!sock || this.#closed) return Promise.reject(new HostError('omo host에 연결되어 있지 않습니다', 'disconnected'));
    const id = `o${++this.#seq}`;
    return new Promise((res, rej) => {
      this.#pending.set(id, { res, rej, type, timer: this.#timer(id, type, ms) });
      sock.write(`${JSON.stringify({ ...params, id, type })}\n`);
    });
  }

  close() { this.#close(); }

  #timer(id: string, type: string, ms: number) {
    return setTimeout(() => {
      const p = this.#pending.get(id);
      if (!p) return;
      this.#pending.delete(id);
      p.rej(new HostError(`omo host가 ${type}에 응답하지 않습니다`, 'timeout'));
    }, ms);
  }

  #data(chunk: Buffer) {
    this.#buf += this.#dec.decode(chunk, { stream: true });
    let start = 0;
    for (let i; (i = this.#buf.indexOf('\n', start)) >= 0; start = i + 1) {
      const line = this.#buf.slice(start, i).replace(/\r$/, '');
      if (!line.trim()) continue;
      let m: any;
      try { m = JSON.parse(line); } catch { continue; }
      this.#record(m);
    }
    this.#buf = this.#buf.slice(start);
  }

  #record(m: any) {
    const p = typeof m.id === 'string' ? this.#pending.get(m.id) : undefined;
    if (m.type === 'response' && p) {
      this.#pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.success) p.res(m.data ?? {});
      else p.rej(new HostError(String(m.error || `${m.command} 실패`), errorCode(m), m.errorData));
      return;
    }
    // The host acknowledges an open or a prompt before it runs on its shared loop; a busy host answers much later.
    const q = m.type === 'queued' ? this.#pending.get(m.for_request) : undefined;
    if (q) {
      clearTimeout(q.timer);
      q.timer = this.#timer(m.for_request, q.type, 10 * 60_000);
      return;
    }
    this.onRecord(m);
  }

  #close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const p of this.#pending.values()) { clearTimeout(p.timer); p.rej(new HostError('omo host 연결이 끊겼습니다', 'disconnected')); }
    this.#pending.clear();
    this.#sock?.destroy();
    this.onClose();
  }
}

async function run(cmd: string[], ms: number) {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), ms);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    let json: any = null;
    try { json = JSON.parse(out.trim().split('\n').at(-1) || ''); } catch {}
    return { json, err: err.trim(), code };
  } finally { clearTimeout(timer); }
}
const detailOf = (j: any) => (j?.detail ? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : j?.reason || '');

// `omo host ensure`: attaches to the host serving the socket, starts one when nothing does, and hands an older engine's
// host over to the installed one (its sessions finish their turns first). One JSON line on stdout; the exit code
// classifies it (0 ok, 1 failed, 3 refused).
export async function ensureHost(socket = HOST_SOCKET) {
  const { json, err, code } = await run(['omo', 'host', 'ensure', '--json', '--socket', socket], 90_000);
  if (code !== 0 || !json) throw new HostError(`omo host를 시작하지 못했습니다: ${detailOf(json) || err || `exit ${code}`}`, json?.reason);
  return json;
}

// The identity of the host now serving the socket, read on a connection of its own: during a handoff the bridge's
// connection still talks to the generation that is draining.
export async function probeHost(socket = HOST_SOCKET) {
  const link = new HostLink(socket, () => {}, () => {});
  await link.open();
  try { return await link.request('get_protocol_info', { observe: true }, 5000); } finally { link.close(); }
}

type Turn = { id: string; status: string; items: any[]; error?: { message: string } };
type Sess = {
  handle: string; id: string; path: string; cwd: string; name: string | null;
  attached: boolean; running: boolean; model: { provider: string; id: string } | null; effort: string | null;
  turn: Turn | null; msg: number; blocks: Map<number, string>; seq: number; stop: { reason: string; error: string } | null;
  compacting: { id: string; own: boolean } | null; goal: string; ticks: Map<string, number>; replaceGoalUntil: number;
  replaced?: (e: any) => void;
};
type Question = { id: string; header?: string; question: string; options: { label: string; description?: string }[] | null; multiSelect: boolean; isOther?: boolean };
type UiReq = { id: string; threadId: string; handle: string; kind: 'question' | 'select' | 'confirm' | 'input'; questions: Question[]; msg: unknown };
export type BridgeClient = { send: (data: string) => void; close: (code: number, reason: string) => void; subs: Set<string>; ready: Promise<void> };
export type BridgeOptions = { socket: string; index: SessionIndex; archive: ArchiveStore; trashDir: string; fallbackModels: () => Promise<any[]> };

const YES = '예', NO = '아니오';
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 생략)` : s);
const inputText = (input: unknown) => (Array.isArray(input) ? input.map((i: any) => (i?.type === 'text' ? i.text : '')).filter(Boolean).join('\n') : '');
const headerOf = (title: unknown) => String(title || '').split('\n')[0].replace(/:.*$/, '').slice(0, 40);
const pickerModel = (m: any) => ({
  id: `${m.provider}/${m.id}`, model: m.id, displayName: m.name || m.id, hidden: false, isDefault: false, defaultReasoningEffort: 'medium',
  supportedReasoningEfforts: (m.supportedThinkingLevels || []).filter((l: string) => l !== 'off').map((reasoningEffort: string) => ({ reasoningEffort, description: '' })),
});

// Events: 'settled' (threadId) when a session's run ends, 'question' ({ threadId, requestId, kind, text }) when one waits
// for an answer.
export class HostBridge extends EventEmitter {
  info: any = null;
  #link: HostLink | null = null;
  #connecting: Promise<void> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #retryMs = 1000;
  #byHandle = new Map<string, Sess>();
  #byId = new Map<string, Sess>();
  #attaching = new Map<string, Promise<Sess>>();
  #clients = new Set<BridgeClient>();
  #reqs = new Map<string, UiReq>();
  #sync: Promise<void> = Promise.resolve();
  #turnSeq = 0;
  #models: { at: number; data: Promise<any[]> } | null = null;
  #tui: { at: number; ids: Promise<Set<string>> } | null = null;

  constructor(readonly opts: BridgeOptions) { super(); }

  start() { this.ready().catch((e) => console.warn('[host]', e?.message || e)); }

  // Resolves once a host connection is up, starting the host when nothing serves the socket.
  ready(): Promise<void> {
    if (this.#link) return Promise.resolve();
    if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }
    this.#connecting ??= this.#connect().then(
      () => { this.#retryMs = 1000; },
      (e) => { this.#schedule(); throw e; },
    ).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  isRunning(id: string) { return !!this.#byId.get(id)?.running; }
  nameOf(id: string) { return this.#byId.get(id)?.name || null; }

  addClient(c: { send: (data: string) => void; close: (code: number, reason: string) => void }): BridgeClient {
    const client: BridgeClient = { ...c, subs: new Set(), ready: Promise.resolve() };
    this.#clients.add(client);
    client.ready = this.ready().catch((e) => { client.close(1011, `omo host에 연결하지 못했습니다: ${e?.message || e}`); throw e; });
    client.ready.catch(() => {});
    return client;
  }
  removeClient(c: BridgeClient) { this.#clients.delete(c); }

  async message(c: BridgeClient, raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    try { await c.ready; } catch { return; }
    if (msg.id != null && typeof msg.method !== 'string') { await this.#answer(String(msg.id), msg.result); return; }
    if (typeof msg.method !== 'string') return;
    try {
      const result = await this.#call(c, msg.method, msg.params || {});
      if (msg.id != null) this.#send(c, { id: msg.id, result: result ?? {} });
    } catch (e: any) {
      if (msg.id != null) this.#send(c, { id: msg.id, error: { code: e?.rpcCode ?? -32000, message: String(e?.message || e) } });
    }
  }

  // ── connection ──
  #schedule() {
    if (this.#retry) return;
    this.#retry = setTimeout(() => { this.#retry = null; this.ready().catch((e) => console.warn('[host]', e?.message || e)); }, this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
  }

  async #connect() {
    let link!: HostLink;
    const make = () => (link = new HostLink(this.opts.socket, (m) => this.#onRecord(link, m), () => this.#onClose(link)));
    try { await make().open(); }
    catch (e: any) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ECONNREFUSED') throw e;
      await ensureHost(this.opts.socket);
      await make().open();
    }
    try {
      this.info = await link.request('get_protocol_info');
      // extension_events: omo's subagent updates; question: ask_user_question as one record instead of select dialogs.
      await link.request('set_client_info', { width: 120, capabilities: ['extension_events', 'question'] });
    } catch (e) { link.close(); throw e; }
    this.#link = link;
    console.log(`[host] omo host ${engineOf(this.info.engineVersion)} (${this.opts.socket})`);
    await this.#syncSessions();
  }

  #onClose(link: HostLink) {
    if (link !== this.#link) return;
    this.#link = null;
    this.info = null;
    this.#byHandle.clear();
    this.#byId.clear();
    this.#reqs.clear();
    this.#models = null;
    // Browsers reconnect and read everything again, as they recover from any lost socket.
    for (const c of this.#clients) c.close(1011, 'omo host 연결이 끊겼습니다');
    console.warn('[host] omo host 연결이 끊겼습니다');
    this.#schedule();
  }

  #req(type: string, params: Record<string, unknown> = {}, ms?: number): Promise<any> {
    const link = this.#link;
    if (!link) return Promise.reject(new HostError('omo host에 연결되어 있지 않습니다', 'disconnected'));
    return link.request(type, params, ms);
  }

  // ── sessions the host holds ──
  #sess(handle: string, id: string, path: string, cwd: string): Sess {
    let s = this.#byHandle.get(handle);
    if (!s) {
      s = { handle, id, path, cwd, name: null, attached: false, running: false, model: null, effort: null, turn: null, msg: 0, blocks: new Map(), seq: 0,
        stop: null, compacting: null, goal: 'null', ticks: new Map(), replaceGoalUntil: 0 };
      this.#byHandle.set(handle, s);
    }
    const old = this.#byId.get(id);
    if (old && old !== s) this.#byHandle.delete(old.handle);
    Object.assign(s, { id, path: path || s.path, cwd: cwd || s.cwd });
    this.#byId.set(id, s);
    return s;
  }

  #apply(s: Sess, st: any) {
    if (!st) return;
    if (st.sessionName) s.name = st.sessionName;
    if (st.model) s.model = { provider: st.model.provider, id: st.model.id };
    if (st.thinkingLevel) s.effort = st.thinkingLevel;
    if (st.sessionFile) s.path = st.sessionFile;
    if (st.cwd) s.cwd = st.cwd;
    s.running = !!st.isStreaming;
  }

  // An open_session answer: this connection is attached and receives the session's content from now on.
  #adopt(handle: string, state: any): Sess {
    const s = this.#sess(handle, state.sessionId, state.sessionFile, state.cwd);
    this.#apply(s, state);
    s.attached = true;
    if (s.running) this.#startTurn(s);
    this.#pushStatus(s);
    return s;
  }

  // Reads the host's session list; one run at a time, and a call during a run gets a fresh run after it.
  #syncSessions() {
    const run = async () => {
      const { sessions = [] } = await this.#req('list_sessions');
      const live = new Set<string>();
      for (const r of sessions) {
        if (r.kind === 'worker' || r.status !== 'open' || !r.durableSessionId) continue;
        live.add(r.sessionId);
        const known = this.#byHandle.has(r.sessionId);
        const s = this.#sess(r.sessionId, r.durableSessionId, r.sessionPath, r.cwd);
        if (r.name) s.name = r.name;
        if (known) continue;
        // get_state is an observing read: it neither attaches this connection nor loads anything.
        this.#apply(s, await this.#req('get_state', { sessionId: s.handle }).catch(() => null));
        this.#notifyAll('thread/started', { thread: await this.#threadOf(s) });
      }
      for (const s of [...this.#byHandle.values()]) if (!live.has(s.handle)) this.#drop(s);
    };
    const next = this.#sync.then(run, run);
    this.#sync = next.catch((e) => console.warn('[host] 세션 목록을 읽지 못했습니다:', e?.message || e));
    return this.#sync;
  }

  #drop(s: Sess) {
    if (this.#byHandle.get(s.handle) === s) this.#byHandle.delete(s.handle);
    if (this.#byId.get(s.id) !== s) return;
    this.#byId.delete(s.id);
    for (const r of [...this.#reqs.values()]) if (r.handle === s.handle) this.#resolve(r);
    if (s.turn) this.#endTurn(s, 'interrupted');
    this.#notifyAll('thread/status/changed', { threadId: s.id, status: { type: 'notLoaded' } });
    this.#notifyAll('thread/closed', { threadId: s.id });
  }

  #attach(id: string): Promise<Sess> {
    const s = this.#byId.get(id);
    if (s?.attached) return Promise.resolve(s);
    let p = this.#attaching.get(id);
    if (!p) {
      p = (async () => {
        const path = s?.path || (await this.opts.index.pathOf(id));
        if (!path) throw new HostError('세션 파일을 찾지 못했습니다');
        try {
          const r = await this.#req('open_session', { sessionPath: path, retain_on_disconnect: true }, 120_000);
          return this.#adopt(r.sessionId, r.state);
        } catch (e: any) {
          if (e?.code !== 'session_held') throw e;
          const pids = ((e.data as any)?.holders || []).map((h: any) => h.pid).filter(Boolean).join(', ');
          throw new HostError(`터미널 omo${pids ? `(pid ${pids})` : ''}가 이 세션을 열고 있습니다. 터미널에서 세션을 끝낸 뒤 다시 시도하세요`, e.code);
        }
      })().finally(() => this.#attaching.delete(id));
      this.#attaching.set(id, p);
    }
    return p;
  }

  async #attachFor(c: BridgeClient, id: string) {
    const s = await this.#attach(id);
    this.#subscribe(c, s);
    return s;
  }

  #subscribe(c: BridgeClient, s: Sess) {
    if (c.subs.has(s.id)) return;
    c.subs.add(s.id);
    for (const r of this.#reqs.values()) if (r.threadId === s.id) this.#send(c, r.msg);
  }

  // ── what the dashboard sees ──
  #status(s: Sess) {
    const waiting = [...this.#reqs.values()].some((r) => r.threadId === s.id);
    return s.running || waiting ? { type: 'active', activeFlags: waiting ? ['waitingOnUserInput'] : [] } : { type: 'idle' };
  }
  #pushStatus(s: Sess) { this.#notifyAll('thread/status/changed', { threadId: s.id, status: this.#status(s) }); }

  async #threadOf(s: Sess, meta?: SessionMeta | null) {
    meta ??= (await this.opts.index.list()).find((m) => m.id === s.id) || null;
    const now = Date.now();
    return {
      id: s.id, name: s.name ?? meta?.name ?? null, preview: meta?.preview || '', cwd: s.cwd || meta?.cwd || '', path: s.path || meta?.path || '',
      source: 'appServer', status: this.#status(s), createdAt: meta?.createdAt || now, updatedAt: meta?.talkedAt || meta?.mtimeMs || now,
      archived: (await this.opts.archive.ids()).has(s.id),
    };
  }

  async #opened(s: Sess) {
    return { thread: await this.#threadOf(s), model: s.model?.id, modelProvider: s.model?.provider, reasoningEffort: s.effort };
  }

  // Sessions on disk, plus the ones the host opened that have no file yet. source 'cli' marks a session a terminal omo
  // holds right now; opening it in the host is refused until that terminal ends it.
  async #list(archived: boolean) {
    const [metas, ids, tui] = await Promise.all([this.opts.index.list(), this.opts.archive.ids(), this.#tuiHeld()]);
    const out: unknown[] = [];
    const seen = new Set<string>();
    for (const m of metas) {
      seen.add(m.id);
      if (ids.has(m.id) !== archived) continue;
      const s = this.#byId.get(m.id);
      out.push({
        id: m.id, name: s?.name ?? m.name, preview: m.preview, cwd: m.cwd, path: m.path, source: tui.has(m.id) ? 'cli' : 'appServer',
        status: s ? this.#status(s) : { type: 'notLoaded' }, createdAt: m.createdAt, updatedAt: m.talkedAt || m.mtimeMs, archived,
      });
    }
    if (!archived) for (const s of this.#byId.values()) if (!seen.has(s.id) && !ids.has(s.id)) out.push(await this.#threadOf(s, null));
    return out;
  }

  // Session ids that live terminal omo processes hold, from their control endpoints (`omo host status --all`).
  #tuiHeld(fresh = false): Promise<Set<string>> {
    if (!fresh && this.#tui && Date.now() - this.#tui.at < 15_000) return this.#tui.ids;
    const ids = run(['omo', 'host', 'status', '--all', '--json'], 8000).then(({ json }) => {
      const held = new Set<string>();
      for (const e of json?.endpoints || []) if (e?.endpoint_kind === 'tui' && e.alive && e.owner?.session?.id) held.add(e.owner.session.id);
      return held;
    }, () => new Set<string>());
    this.#tui = { at: Date.now(), ids };
    return ids;
  }

  #modelList() {
    if (!this.#models || Date.now() - this.#models.at > 60_000) {
      // get_available_models answers for any session the host lists, without attaching; with none, ask omo directly.
      const any = this.#byHandle.values().next().value as Sess | undefined;
      const data = (any ? this.#req('get_available_models', { sessionId: any.handle }).then((r) => r.models || []) : this.opts.fallbackModels())
        .then((ms: any[]) => ms.map(pickerModel));
      this.#models = { at: Date.now(), data };
      data.catch(() => { if (this.#models?.data === data) this.#models = null; });
    }
    return this.#models.data;
  }

  async #read(id: string, includeTurns: boolean) {
    const s = this.#byId.get(id);
    if (s) return { ...(await this.#threadOf(s)), turns: includeTurns && s.turn ? [{ ...s.turn, items: [...s.turn.items] }] : [] };
    const m = (await this.opts.index.list()).find((x) => x.id === id);
    if (!m) throw new HostError('세션을 찾지 못했습니다');
    return { id, name: m.name, preview: m.preview, cwd: m.cwd, path: m.path, source: 'appServer', status: { type: 'notLoaded' }, createdAt: m.createdAt, updatedAt: m.talkedAt || m.mtimeMs, turns: [] };
  }

  #send(c: BridgeClient, msg: unknown) { try { c.send(JSON.stringify(msg)); } catch {} }
  #notifyAll(method: string, params: unknown) { for (const c of this.#clients) this.#send(c, { method, params }); }
  #notifySubs(id: string, method: string, params: unknown) { for (const c of this.#clients) if (c.subs.has(id)) this.#send(c, { method, params }); }

  // ── turns and items, rebuilt from the host's agent events ──
  #startTurn(s: Sess) {
    if (s.turn) return s.turn;
    s.turn = { id: `host-${++this.#turnSeq}`, status: 'inProgress', items: [] };
    s.stop = null;
    this.#notifySubs(s.id, 'turn/started', { threadId: s.id, turn: { id: s.turn.id, status: 'inProgress' } });
    return s.turn;
  }

  #item(s: Sess, method: 'item/started' | 'item/completed', item: any) {
    const turn = this.#startTurn(s);
    const i = turn.items.findIndex((x) => x.id === item.id);
    if (i >= 0) turn.items[i] = { ...turn.items[i], ...item }; else turn.items.push(item);
    this.#notifySubs(s.id, method, { threadId: s.id, turnId: turn.id, item });
  }

  #endTurn(s: Sess, status: string) {
    const t = s.turn;
    if (!t) return;
    s.turn = null;
    t.status = status;
    this.#notifySubs(s.id, 'turn/completed', { threadId: s.id, turn: { id: t.id, status, ...(t.error && { error: t.error }) } });
  }

  #append(s: Sess, id: string, delta: string) {
    const it = s.turn?.items.find((x) => x.id === id);
    if (!it) return;
    if (it.type === 'reasoning') it.content = [`${it.content?.[0] || ''}${delta}`];
    else it.text = `${it.text || ''}${delta}`;
  }

  #onRecord(link: HostLink, m: any) {
    if (link !== this.#link) return;
    try { this.#event(m); } catch (e: any) { console.error('[host] 이벤트를 처리하지 못했습니다:', m?.type, e?.message || e); }
  }

  #event(m: any) {
    switch (m.type) {
      case 'session_opened': void this.#syncSessions(); return;
      case 'session_closed': case 'session_parked': { const s = this.#byHandle.get(m.sessionId); if (s) this.#drop(s); return; }
      case 'host_superseded': console.log('[host] 새 omo host로 넘어갑니다. 세션은 하던 턴을 마친 뒤 옮겨집니다'); return;
    }
    if (!m.sessionId) return;
    const s = this.#byHandle.get(m.sessionId);
    if (!s) { if (m.type === 'agent_start' || m.type === 'agent_settled') void this.#syncSessions(); return; }
    switch (m.type) {
      // agent_start and agent_settled reach every connection; the rest only connections attached to the session.
      case 'agent_start':
        if (!s.running) { s.running = true; this.#pushStatus(s); }
        if (s.attached) this.#startTurn(s);
        return;
      case 'agent_end':
        if (s.stop?.reason === 'error' && !m.willRetry) this.#notifySubs(s.id, 'error', { threadId: s.id, error: { message: s.stop.error || '오류로 턴이 끝났습니다' }, willRetry: false });
        return;
      case 'agent_settled': this.#settled(s); return;
      case 'message_start': this.#messageStart(s, m.message); return;
      case 'message_update': this.#delta(s, m); return;
      case 'message_end': this.#messageEnd(s, m.message); return;
      case 'tool_execution_start':
        this.#item(s, 'item/started', { type: 'dynamicToolCall', id: m.toolCallId, tool: m.toolName, arguments: m.args ?? {}, status: 'inProgress', contentItems: [] });
        return;
      case 'tool_execution_update': {
        // partialResult is the whole output so far; twice a second is enough for the timeline.
        const now = Date.now();
        if (now - (s.ticks.get(m.toolCallId) || 0) < 500) return;
        s.ticks.set(m.toolCallId, now);
        this.#item(s, 'item/started', { type: 'dynamicToolCall', id: m.toolCallId, tool: m.toolName, status: 'inProgress', contentItems: [{ type: 'inputText', text: clip(textOf(m.partialResult?.content)) }] });
        return;
      }
      case 'tool_execution_end':
        s.ticks.delete(m.toolCallId);
        this.#item(s, 'item/completed', {
          type: 'dynamicToolCall', id: m.toolCallId, tool: m.toolName, status: m.isError ? 'failed' : 'completed', success: !m.isError,
          contentItems: [{ type: 'inputText', text: clip(textOf(m.result?.content)) }],
        });
        return;
      case 'compaction_start': {
        if (!s.attached) return;
        s.compacting = { id: `${s.handle}:c${++s.seq}`, own: !s.turn };
        this.#item(s, 'item/started', { type: 'contextCompaction', id: s.compacting.id, status: 'inProgress' });
        return;
      }
      case 'compaction_end': {
        const c = s.compacting;
        if (!c) return;
        s.compacting = null;
        this.#item(s, 'item/completed', { type: 'contextCompaction', id: c.id, status: m.aborted ? 'interrupted' : 'completed' });
        if (c.own && !s.running) this.#endTurn(s, 'completed');
        return;
      }
      case 'model_changed':
        if (m.model) s.model = { provider: m.model.provider, id: m.model.id };
        if (m.thinkingLevel) s.effort = m.thinkingLevel;
        this.#notifyAll('thread/settings/updated', { threadId: s.id, threadSettings: { model: s.model?.id, modelProvider: s.model?.provider, effort: s.effort } });
        return;
      case 'extension_event':
        if (m.name === 'omo.task.updated') this.#notifySubs(s.id, 'extension_event', { threadId: s.id, name: m.name, data: m.data });
        return;
      case 'extension_ui_request': this.#ui(s, m); return;
      case 'question_resolved': { const r = this.#reqs.get(m.id); if (r) this.#resolve(r); return; }
      case 'session_replaced': this.#replaced(s, m); return;
    }
  }

  #messageStart(s: Sess, msg: any) {
    if (!s.attached || !msg) return;
    if (msg.role === 'user') {
      this.#item(s, 'item/completed', { type: 'userMessage', id: `${s.handle}:u${++s.seq}`, status: 'completed', content: [{ type: 'text', text: textOf(msg.content) }] });
    } else if (msg.role === 'assistant') {
      s.msg = ++s.seq;
      s.blocks = new Map();
    }
  }

  #delta(s: Sess, m: any) {
    const e = m.assistantMessageEvent;
    if (!e || !s.attached) return;
    const ci = e.contentIndex ?? 0;
    const id = `${s.handle}:m${s.msg}:${ci}`;
    const open = (type: 'agentMessage' | 'reasoning') => {
      if (s.blocks.has(ci)) return;
      s.blocks.set(ci, id);
      this.#item(s, 'item/started', type === 'agentMessage' ? { type, id, text: '', status: 'inProgress' } : { type, id, content: [], status: 'inProgress' });
    };
    const textSoFar = () => s.turn?.items.find((x) => x.id === id);
    switch (e.type) {
      case 'text_start': open('agentMessage'); return;
      case 'text_delta':
        open('agentMessage');
        this.#append(s, id, e.delta || '');
        this.#notifySubs(s.id, 'item/agentMessage/delta', { threadId: s.id, turnId: s.turn!.id, itemId: id, delta: e.delta || '' });
        return;
      case 'text_end': open('agentMessage'); this.#item(s, 'item/completed', { type: 'agentMessage', id, text: e.content ?? textSoFar()?.text ?? '', status: 'completed' }); return;
      case 'thinking_start': open('reasoning'); return;
      case 'thinking_delta':
        open('reasoning');
        this.#append(s, id, e.delta || '');
        this.#notifySubs(s.id, 'item/reasoning/textDelta', { threadId: s.id, turnId: s.turn!.id, itemId: id, delta: e.delta || '', contentIndex: ci });
        return;
      case 'thinking_end': open('reasoning'); this.#item(s, 'item/completed', { type: 'reasoning', id, content: [e.content || textSoFar()?.content?.[0] || ''], status: 'completed' }); return;
      case 'toolcall_start':
        if (e.id) this.#item(s, 'item/started', { type: 'dynamicToolCall', id: e.id, tool: m.resolvedToolName || e.toolName, arguments: {}, status: 'inProgress', contentItems: [] });
        return;
      case 'toolcall_end':
        if (e.toolCall?.id) this.#item(s, 'item/started', { type: 'dynamicToolCall', id: e.toolCall.id, tool: m.resolvedToolName || e.toolCall.name, arguments: e.toolCall.arguments ?? {}, status: 'inProgress' });
        return;
    }
  }

  #messageEnd(s: Sess, msg: any) {
    if (msg?.role !== 'assistant') return;
    s.stop = { reason: String(msg.stopReason || ''), error: String(msg.errorMessage || '') };
    if (s.turn) {
      if (msg.stopReason === 'error') s.turn.error = { message: msg.errorMessage || '오류로 턴이 끝났습니다' };
      else delete s.turn.error; // a retry that went through
    }
    if (!s.attached) return;
    // A provider that does not stream hands over whole blocks here.
    (msg.content || []).forEach((b: any, ci: number) => {
      if (b?.type !== 'text' || !b.text?.trim() || s.blocks.has(ci)) return;
      const id = `${s.handle}:m${s.msg}:${ci}`;
      s.blocks.set(ci, id);
      this.#item(s, 'item/completed', { type: 'agentMessage', id, text: b.text, status: 'completed' });
    });
  }

  #settled(s: Sess) {
    const was = s.running;
    s.running = false;
    const status = s.stop?.reason === 'error' ? 'failed' : s.stop?.reason === 'aborted' ? 'interrupted' : 'completed';
    this.#pushStatus(s);
    this.#endTurn(s, status);
    if (was) this.emit('settled', s.id);
    // omo names a session after its first turns, in the background and without an event.
    for (const ms of [4000, 40_000]) setTimeout(() => void this.#refreshName(s), ms);
  }

  async #refreshName(s: Sess) {
    if (this.#byHandle.get(s.handle) !== s) return;
    const st = await this.#req('get_state', { sessionId: s.handle }).catch(() => null);
    if (st?.sessionName && st.sessionName !== s.name) {
      s.name = st.sessionName;
      this.#notifyAll('thread/name/updated', { threadId: s.id, threadName: s.name });
    }
  }

  // new_session, switch_session and fork/clone keep the routing handle and swap the session behind it.
  #replaced(s: Sess, m: any) {
    const oldId = s.id;
    if (this.#byId.get(oldId) === s) this.#byId.delete(oldId);
    for (const r of [...this.#reqs.values()]) if (r.handle === s.handle) this.#resolve(r);
    s.turn = null;
    Object.assign(s, { id: m.durableSessionId, path: m.sessionFile || '', cwd: m.cwd || s.cwd, name: m.sessionName ?? null, goal: '' });
    this.#byId.set(s.id, s);
    for (const c of this.#clients) if (c.subs.has(oldId)) c.subs.add(s.id);
    this.#notifyAll('thread/status/changed', { threadId: oldId, status: { type: 'notLoaded' } });
    this.#notifyAll('thread/closed', { threadId: oldId });
    void this.#threadOf(s).then((thread) => this.#notifyAll('thread/started', { thread }));
    s.replaced?.(m);
  }

  // ── questions and dialogs → item/tool/requestUserInput ──
  #ui(s: Sess, m: any) {
    switch (m.method) {
      case 'question':
        this.#ask(s, m, 'question', (m.questions || []).map((q: any) => ({
          id: String(q.id), header: q.header, question: String(q.question || ''), multiSelect: !!q.multiSelect,
          options: q.options?.length ? q.options.map((o: any) => ({ label: String(o.label), description: o.description })) : null,
        })));
        return;
      case 'select': {
        // The dashboard's goal editor already chose to replace the goal; omo's /goal confirms it with a picker.
        if (Date.now() < s.replaceGoalUntil && String(m.title || '').startsWith('Replace goal?')) {
          s.replaceGoalUntil = 0;
          const value = (m.options || []).find((o: string) => /^Replace/.test(o)) ?? m.options?.[0];
          this.#req('extension_ui_response', { sessionId: s.handle, uiRequestId: m.id, value }).catch((e) => console.warn('[host] 목표 교체를 확인하지 못했습니다:', e?.message || e));
          return;
        }
        this.#ask(s, m, 'select', [{ id: 'answer', header: headerOf(m.title), question: String(m.title || ''), options: (m.options || []).map((label: string) => ({ label: String(label) })), multiSelect: false, isOther: false }]);
        return;
      }
      case 'confirm':
        this.#ask(s, m, 'confirm', [{ id: 'answer', header: headerOf(m.title), question: [m.title, m.message].filter(Boolean).join('\n\n'), options: [{ label: YES }, { label: NO }], multiSelect: false, isOther: false }]);
        return;
      case 'input': case 'editor':
        this.#ask(s, m, 'input', [{ id: 'answer', header: headerOf(m.title), question: String(m.title || ''), options: null, multiSelect: false }]);
        return;
      case 'setStatus':
        if (m.statusKey === 'goal') void this.#refreshGoal(s);
        return;
    }
  }

  #ask(s: Sess, m: any, kind: UiReq['kind'], questions: Question[]) {
    if (this.#reqs.has(m.id)) return; // replayed to a connection that attaches later
    const timeoutMs = m.remainingMs ?? m.timeout;
    const r: UiReq = {
      id: m.id, threadId: s.id, handle: s.handle, kind, questions,
      msg: { id: m.id, method: 'item/tool/requestUserInput', params: { threadId: s.id, turnId: s.turn?.id || '', itemId: m.toolCallId || m.id, questions, waitForAnswer: m.waitForAnswer !== false, ...(timeoutMs ? { timeoutMs } : {}) } },
    };
    this.#reqs.set(r.id, r);
    for (const c of this.#clients) if (c.subs.has(s.id)) this.#send(c, r.msg);
    this.#pushStatus(s);
    this.emit('question', { threadId: s.id, requestId: r.id, kind: String(m.title || '').startsWith('Permission required') ? 'approval' : 'question', text: questions[0]?.question || '' });
  }

  #resolve(r: UiReq) {
    if (!this.#reqs.delete(r.id)) return;
    this.#notifyAll('serverRequest/resolved', { threadId: r.threadId, requestId: r.id });
    const s = this.#byId.get(r.threadId);
    if (s) this.#pushStatus(s);
  }

  // The dashboard answers like app-server's requestUserInput: { answers: { [questionId]: { answers: string[] } }, comment }.
  // Picked option labels go to `selected`, typed text to `text`.
  async #answer(id: string, result: any) {
    const r = this.#reqs.get(id);
    if (!r) return;
    const frame: Record<string, unknown> = { sessionId: r.handle, uiRequestId: r.id };
    const answers = result?.answers || {};
    if (r.kind === 'question') {
      const out: Record<string, { selected: string[]; text?: string }> = {};
      for (const q of r.questions) {
        const given: string[] = (answers[q.id]?.answers || []).map(String).filter(Boolean);
        if (!given.length) continue;
        const labels = new Set((q.options || []).map((o) => o.label));
        const text = given.filter((a) => !labels.has(a)).join('\n');
        out[q.id] = { selected: given.filter((a) => labels.has(a)), ...(text && { text }) };
      }
      const comment = String(result?.comment || '').trim();
      if (Object.keys(out).length || comment) Object.assign(frame, { answers: out, ...(comment && { comment }) });
      else frame.cancelled = true;
    } else {
      const v = answers.answer?.answers?.[0];
      if (v == null || v === '') frame.cancelled = true;
      else if (r.kind === 'confirm') frame.confirmed = v === YES;
      else frame.value = String(v);
    }
    try { await this.#req('extension_ui_response', frame); }
    catch (e: any) { if (!/already_resolved/.test(`${e?.code} ${e?.message}`)) console.warn('[host] 답을 보내지 못했습니다:', e?.message || e); }
    // Dialogs other than questions announce no resolution.
    if (r.kind !== 'question') this.#resolve(r);
  }

  async #refreshGoal(s: Sess) {
    const goal = s.path ? await readGoal(s.path, s.id).catch(() => null) : null;
    const key = JSON.stringify(goal);
    if (key !== s.goal) {
      s.goal = key;
      this.#notifyAll(goal ? 'thread/goal/updated' : 'thread/goal/cleared', { threadId: s.id, ...(goal && { goal }) });
    }
    return goal;
  }

  async #prompt(s: Sess, text: string) {
    const steer = () => this.#req('steer', { sessionId: s.handle, message: text, whenIdle: 'start' }, 120_000);
    if (s.running) await steer();
    else await this.#req('prompt', { sessionId: s.handle, message: text }, 120_000).catch((e) => (e?.code === 'streaming' ? steer() : Promise.reject(e)));
    return { turn: { id: s.turn?.id || '', status: 'inProgress' } };
  }

  // ── app-server requests ──
  async #call(c: BridgeClient, method: string, p: any): Promise<unknown> {
    const id = String(p.threadId || '');
    switch (method) {
      case 'initialize': {
        const v = engineOf(this.info?.engineVersion);
        return { userAgent: `omonitor-host/${v}`, serverInfo: { name: 'omo host', version: v } };
      }
      case 'thread/list': return { data: await this.#list(!!p.archived), nextCursor: null };
      case 'thread/loaded/list': return { data: [...this.#byId.keys()] };
      case 'model/list': return { data: await this.#modelList() };
      case 'thread/read': return { thread: await this.#read(id, !!p.includeTurns) };
      case 'thread/resume': return this.#opened(await this.#attachFor(c, id));
      case 'thread/start': {
        // A model chosen for the new session goes into open_session: set_model would also make it omo's default model.
        const [provider, ...rest] = typeof p.model === 'string' ? p.model.split('/') : [];
        const r = await this.#req('open_session', {
          cwd: p.cwd, retain_on_disconnect: true, auto_title: true,
          ...(rest.length && { provider, modelId: rest.join('/') }), ...(p.effort && { thinkingLevel: p.effort }),
        }, 120_000);
        const s = this.#adopt(r.sessionId, r.state);
        this.#subscribe(c, s);
        const out = await this.#opened(s);
        for (const o of this.#clients) if (o !== c) this.#send(o, { method: 'thread/started', params: { thread: out.thread } });
        return out;
      }
      case 'thread/unsubscribe': c.subs.delete(id); return {};
      case 'turn/start': return this.#prompt(await this.#attachFor(c, id), inputText(p.input));
      case 'turn/steer': {
        const s = await this.#attachFor(c, id);
        await this.#req('steer', { sessionId: s.handle, message: inputText(p.input), whenIdle: 'start' }, 120_000);
        return { turnId: s.turn?.id || p.expectedTurnId || '' };
      }
      case 'turn/interrupt': { const s = await this.#attachFor(c, id); await this.#req('abort', { sessionId: s.handle }, 60_000); return {}; }
      // set_model also saves the model as omo's default for new sessions, as /model does in a terminal; the level stays
      // with this session (scope 'turn') instead of becoming the model's remembered level.
      case 'thread/settings/update': {
        const s = await this.#attachFor(c, id);
        if (p.model) {
          const [provider, ...rest] = String(p.model).split('/');
          if (!rest.length) throw new HostError(`모델은 provider/id 형식이어야 합니다: ${p.model}`);
          const m = await this.#req('set_model', { sessionId: s.handle, provider, modelId: rest.join('/') });
          if (m?.provider) s.model = { provider: m.provider, id: m.id };
        }
        if (p.effort) { await this.#req('set_thinking_level', { sessionId: s.handle, level: p.effort, scope: 'turn' }); s.effort = p.effort; }
        this.#notifyAll('thread/settings/updated', { threadId: s.id, threadSettings: { model: s.model?.id, modelProvider: s.model?.provider, effort: s.effort } });
        return {};
      }
      case 'thread/name/set': {
        const s = await this.#attachFor(c, id);
        await this.#req('set_session_name', { sessionId: s.handle, name: String(p.name || '') });
        s.name = String(p.name || '');
        this.#notifyAll('thread/name/updated', { threadId: s.id, threadName: s.name });
        return {};
      }
      case 'thread/compact/start': {
        const s = await this.#attachFor(c, id);
        // Compaction can run for minutes; its progress arrives as compaction_start/end.
        this.#req('compact', { sessionId: s.handle }, 20 * 60_000).catch((e) => this.#notifySubs(s.id, 'error', { threadId: s.id, error: { message: `압축하지 못했습니다: ${e?.message || e}` } }));
        return {};
      }
      case 'thread/goal/get': {
        const path = this.#byId.get(id)?.path || (await this.opts.index.pathOf(id));
        return { goal: path ? await readGoal(path, id) : null };
      }
      // The host has no goal commands; omo's /goal command runs as a prompt without starting a turn of its own.
      case 'thread/goal/set': {
        const cmd = p.objective ? `/goal ${String(p.objective).trim()}` : p.status === 'paused' ? '/goal pause' : p.status === 'active' ? '/goal resume' : null;
        if (!cmd) throw new HostError(p.status === 'complete' ? '목표 완료는 에이전트가 확인한 뒤 직접 표시합니다. 대시보드에서는 일시정지나 해제를 쓰세요' : '바꿀 목표 내용이 없습니다');
        const s = await this.#attachFor(c, id);
        if (p.objective) s.replaceGoalUntil = Date.now() + 30_000;
        await this.#req('prompt', { sessionId: s.handle, message: cmd }, 120_000);
        return { goal: await this.#refreshGoal(s) };
      }
      case 'thread/goal/clear': {
        const s = await this.#attachFor(c, id);
        await this.#req('prompt', { sessionId: s.handle, message: '/goal clear' }, 60_000);
        await this.#refreshGoal(s);
        return {};
      }
      case 'thread/archive': await this.opts.archive.set(id, true); this.#notifyAll('thread/archived', { threadId: id }); return {};
      case 'thread/unarchive': await this.opts.archive.set(id, false); this.#notifyAll('thread/unarchived', { threadId: id }); return {};
      case 'thread/delete': return this.#delete(id);
      case 'thread/fork': return this.#fork(c, id);
    }
    throw Object.assign(new HostError(`omo host 연동에서 지원하지 않는 요청입니다: ${method}`), { rpcCode: -32601 });
  }

  async #delete(id: string) {
    if ((await this.#tuiHeld(true)).has(id)) throw new HostError('터미널 omo가 이 세션을 열고 있습니다. 터미널에서 세션을 끝낸 뒤 삭제하세요');
    const s = this.#byId.get(id);
    if (s) {
      if (s.running) throw new HostError('작업 중인 세션은 삭제할 수 없습니다');
      const row = (await this.#req('list_sessions')).sessions?.find((r: any) => r.sessionId === s.handle);
      if (!s.attached || (row?.attachments ?? 0) > 1) throw new HostError('다른 omo 클라이언트가 이 세션을 열고 있어 삭제할 수 없습니다');
      await this.#req('close_session', { sessionId: s.handle }, 30_000);
      this.#drop(s);
    }
    const path = s?.path || (await this.opts.index.pathOf(id));
    if (path && (await Bun.file(path).exists())) {
      await trashSession(path, id, this.opts.trashDir);
      this.opts.index.forget(path);
    }
    await this.opts.archive.set(id, false);
    this.#notifyAll('thread/deleted', { threadId: id });
    return {};
  }

  // clone copies the active branch into a new session behind the same routing handle, which then drives the copy; the
  // original is opened again by its path.
  async #fork(c: BridgeClient, id: string) {
    const s = await this.#attachFor(c, id);
    if (s.running) throw new HostError('작업 중인 세션은 복제할 수 없습니다. 턴이 끝난 뒤 다시 시도하세요');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replaced = new Promise<void>((res, rej) => {
      s.replaced = () => res();
      timer = setTimeout(() => rej(new HostError('복제한 세션을 받지 못했습니다')), 30_000);
    });
    try {
      const r = await this.#req('clone', { sessionId: s.handle }, 60_000);
      if (r?.cancelled) throw new HostError('확장이 복제를 취소했습니다');
      await replaced;
    } finally { clearTimeout(timer); s.replaced = undefined; }
    const copy = await this.#opened(s);
    await this.#attachFor(c, id).catch((e) => console.warn('[host] 원본 세션을 다시 열지 못했습니다:', e?.message || e));
    return copy;
  }
}
