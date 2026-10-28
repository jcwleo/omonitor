// omonitor ⇄ OpenCode 2 (opencode2). OpenCode 2 runs one shared background server per user (`opencode service`) that
// owns every session, configuration and tool run; clients drive it over HTTP and follow one server-sent event stream
// (/api/event). OpencodeBridge speaks the dashboard's app-server protocol to the browser, as HostBridge does for omo,
// so store.js and the components stay the same in both modes. The wire shapes come from the server's /openapi.json and
// the event types of @opencode/client; the event payloads are not in the OpenAPI document.
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BridgeClient } from './host.ts';

// The service writes its URL and generated password here when it starts (`opencode debug paths state`).
const SERVICE_FILE = process.env.OPENCODE_SERVICE_FILE || join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'opencode/service.json');
// `opencode2` is the 2.x beta's own name; a 2.x install also answers to `opencode`.
export const opencodeBin = () => Bun.which('opencode2') || Bun.which('opencode');
export const opencodeInstalled = async () => !!Bun.which('opencode2') || (await Bun.file(SERVICE_FILE).exists());

export class OpencodeError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

type Service = { url: string; auth: string; version: string };
async function readService(): Promise<{ url: string; password: string } | null> {
  try {
    const j = JSON.parse(await readFile(SERVICE_FILE, 'utf8'));
    return typeof j?.url === 'string' && typeof j.password === 'string' ? j : null;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw e;
  }
}
async function probe(url: string, auth: string) {
  try {
    const r = await fetch(`${url}/api/info`, { headers: { authorization: auth }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
async function run(cmd: string[], ms: number) {
  const p = Bun.spawn(cmd, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => p.kill(), ms);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out: out.trim(), err: err.trim(), code };
  } finally { clearTimeout(timer); }
}
// The shared service answering at the URL its state file names, started when nothing answers. The password is the
// service's own (Basic auth, user "opencode") and stays in this process.
async function ensureService(): Promise<Service> {
  for (let attempt = 0; ; attempt++) {
    const s = await readService();
    if (s) {
      const auth = `Basic ${btoa(`opencode:${s.password}`)}`;
      const url = s.url.replace(/\/+$/, '');
      const info = await probe(url, auth);
      if (info) return { url, auth, version: String(info.version || '') };
    }
    if (attempt) throw new OpencodeError('opencode 서버가 응답하지 않습니다. `opencode2 service status`로 확인하세요');
    const bin = opencodeBin();
    if (!bin) throw new OpencodeError('opencode2를 찾지 못했습니다');
    const r = await run([bin, 'service', 'start'], 60_000);
    if (r.code !== 0) throw new OpencodeError(`opencode 서버를 시작하지 못했습니다: ${r.err || r.out || `exit ${r.code}`}`);
  }
}

const HISTORY_TURNS = 60;
const PREVIEW_MAX = 400;
const YES = '예', NO = '아니오';
const enc = encodeURIComponent;
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 생략)` : s);
const textOf = (content: any): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
const inputText = (input: unknown) => (Array.isArray(input) ? input.map((i: any) => (i?.type === 'text' ? i.text : '')).filter(Boolean).join('\n') : '');
const TURN_STATUS: Record<string, string> = { succeeded: 'completed', failed: 'failed', interrupted: 'interrupted' };
// Skills attached to a prompt come back as attachments; the timeline folds a leading `/skill:id` into a skill chip.
const promptText = (p: any) => `${(Array.isArray(p?.skills) ? p.skills : []).map((k: any) => `/skill:${k.id} `).join('')}${p?.text || ''}`;

// ── tool calls → timeline items ──
// The shell tool reads like a command; the rest stay tool rows, with the argument that says what they did as summary.
const SUMMARY: Record<string, string> = { webfetch: 'url', websearch: 'query', glob: 'pattern', grep: 'pattern', skill: 'id', subagent: 'description' };
function toolItem(id: string, name: string, input: any, state: any, cwd: string) {
  const failed = state?.status === 'error';
  const status = state?.status === 'completed' ? 'completed' : failed ? (state.error?.type === 'aborted' ? 'interrupted' : 'failed') : 'inProgress';
  const out = clip(textOf(state?.content) || (failed ? String(state.error?.message || '') : ''));
  const args = input && typeof input === 'object' ? input : {};
  if (name === 'shell') {
    const exit = state?.metadata?.exit;
    return { type: 'commandExecution', id, command: String(args.command || ''), cwd, aggregatedOutput: out, exitCode: typeof exit === 'number' ? exit : null, status };
  }
  const key = SUMMARY[name];
  const summary = key && typeof args[key] === 'string' ? args[key] : name === 'question' ? args.questions?.[0]?.question : '';
  return { type: 'dynamicToolCall', id, tool: name, arguments: summary ? { ...args, summary } : args, status, success: !failed, contentItems: [{ type: 'inputText', text: out }] };
}

// Saved messages → turns, one per user message, like omo's session files. Item ids match the live ones (message id
// plus the part's place among the message's text or reasoning parts, tool call ids), so a running turn read from both
// places merges.
export function historyTurns(msgs: any[], cwd: string) {
  const turns: any[] = [];
  let cur: any = null;
  const open = (id: string, at: number) => (cur = turns[turns.push({ id: `file-${id}`, status: 'completed', items: [], askedAt: at, lastAt: at }) - 1]);
  const push = (m: any, item: any) => (cur || open(m.id, m.time?.created || 0)).items.push(item);
  for (const m of msgs) {
    switch (m?.type) {
      case 'user': open(m.id, m.time?.created || 0).items.push({ type: 'userMessage', id: m.id, content: [{ type: 'text', text: promptText(m) }] }); break;
      case 'assistant': {
        const n = { text: 0, reasoning: 0 };
        for (const c of m.content || []) {
          if (c?.type === 'text') { const k = n.text++; if (c.text?.trim()) push(m, { type: 'agentMessage', id: `${m.id}:t${k}`, text: c.text, status: 'completed' }); }
          else if (c?.type === 'reasoning') { const k = n.reasoning++; if (c.text?.trim()) push(m, { type: 'reasoning', id: `${m.id}:r${k}`, content: [c.text], status: 'completed' }); }
          else if (c?.type === 'tool') push(m, toolItem(c.id, c.name, c.state?.input, c.state, cwd));
        }
        break;
      }
      // A command the user ran with `!`.
      case 'shell':
        push(m, { type: 'commandExecution', id: m.id, command: m.command || '', cwd, aggregatedOutput: clip(m.output?.output || ''), exitCode: typeof m.exit === 'number' ? m.exit : null,
          status: m.status === 'running' ? 'inProgress' : m.status === 'exited' ? 'completed' : 'interrupted' });
        break;
      case 'compaction': push(m, { type: 'contextCompaction', id: m.id, status: m.status === 'running' ? 'inProgress' : m.status === 'failed' ? 'failed' : 'completed' }); break;
      case 'skill': push(m, { type: 'dynamicToolCall', id: m.id, tool: 'skill', arguments: { summary: m.name || m.skill }, status: 'completed', success: true, contentItems: [] }); break;
      // Each run ends with an idle message carrying its outcome.
      case 'idle':
        if (!cur) continue;
        cur.status = TURN_STATUS[m.outcome] || 'completed';
        if (m.outcome === 'failed' && m.error?.message) cur.error = { message: m.error.message }; else delete cur.error;
        break;
      default: continue; // system notices, synthetic messages, agent/model/location switches
    }
    const at = m.time?.completed || m.time?.created || 0;
    if (cur && at > (cur.lastAt || 0)) cur.lastAt = at;
  }
  return turns;
}

// ── forms (the question tool and plugin forms) → requestUserInput questions ──
function formQuestions(f: any) {
  return (f.fields || []).filter((fl: any) => !fl.hidden).map((fl: any) => {
    const options = fl.type === 'boolean' ? [{ label: YES }, { label: NO }]
      : Array.isArray(fl.options) && fl.options.length ? fl.options.map((o: any) => ({ label: String(o.label ?? o.value), description: o.description })) : null;
    // The question tool puts the short header in title and the question in description.
    return {
      id: String(fl.key), header: String((fl.description ? fl.title : '') || f.title || '').slice(0, 40), question: String(fl.description || fl.title || f.title || ''),
      options, multiSelect: fl.type === 'multiselect', ...(options && { isOther: fl.type !== 'boolean' && fl.custom === true }),
    };
  });
}
// The dashboard answers like app-server: { answers: { [questionId]: { answers: string[] } }, comment }. Picked labels map
// back to option values; anything else is typed text.
function formAnswer(f: any, result: any) {
  const answers = result?.answers || {};
  const out: Record<string, unknown> = {};
  const fields = (f.fields || []).filter((fl: any) => !fl.hidden);
  for (const fl of fields) {
    const given: string[] = (answers[fl.key]?.answers || []).map(String).filter(Boolean);
    if (!given.length) continue;
    const value = new Map<string, unknown>((fl.options || []).map((o: any) => [String(o.label ?? o.value), o.value]));
    const pick = (g: string) => (value.has(g) ? value.get(g) : g);
    if (fl.type === 'boolean') out[fl.key] = given[0] === YES;
    else if (fl.type === 'number' || fl.type === 'integer') { const n = Number(given[0]); if (Number.isFinite(n)) out[fl.key] = n; }
    else if (fl.type === 'multiselect') out[fl.key] = given.map(pick);
    else out[fl.key] = given.length === 1 ? pick(given[0]) : given.join('\n');
  }
  const comment = String(result?.comment || '').trim();
  const free = comment && fields.find((fl: any) => fl.type === 'string' && out[fl.key] == null);
  if (free) out[free.key] = comment;
  return out;
}

// ── permissions → approvals ──
const FILE_ACTIONS = new Set(['edit', 'write', 'patch', 'apply_patch']);
const ACTION_KO: Record<string, string> = { shell: '명령 실행', edit: '파일 수정', write: '파일 쓰기', read: '파일 읽기', webfetch: '웹 페이지 읽기', websearch: '웹 검색', external_directory: '작업 폴더 밖 접근' };
const DECISION: Record<string, string> = { accept: 'once', acceptForSession: 'always', decline: 'reject', cancel: 'reject' };

type Model = { id: string; providerID: string; variant?: string };
type Turn = { id: string; status: string; items: any[]; error?: { message: string } };
type Sess = {
  id: string; parentID: string | null; title: string | null; preview: string; previewRead: boolean; cwd: string; agent: string | null; model: Model | null;
  createdAt: number; updatedAt: number; idleAt: number | null; startedAt: number | null; archived: boolean; outcome: string | null;
  running: boolean; turn: Turn | null; seq: number; inbox: Map<string, string>; tools: Map<string, { name: string; input: any }>; compacting: { id: string; own: boolean } | null;
};
type Req = { id: string; threadId: string; kind: 'permission' | 'form'; form?: any; msg: any };

// Events: 'settled' (threadId) when a session's run ends, 'question' ({ threadId, requestId, kind, text }) when one waits
// for an answer. Child sessions (subagents) are tracked for their parent's agents tab and never reach the board.
export class OpencodeBridge extends EventEmitter {
  url = '';
  version = '';
  #svc: Service | null = null;
  #ac: AbortController | null = null;
  #connecting: Promise<void> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #retryMs = 1000;
  #lastWarn = '';
  #byId = new Map<string, Sess>();
  #fetching = new Map<string, Promise<Sess | null>>();
  #clients = new Set<BridgeClient>();
  #reqs = new Map<string, Req>();
  // Events that arrive while the session list is read are applied after it.
  #buffer: any[] | null = null;
  #turnSeq = 0;
  #models: { at: number; data: Promise<any[]> } | null = null;
  #commands: { at: number; names: Promise<Set<string>> } | null = null;

  start() { this.ready().catch(() => {}); }

  ready(): Promise<void> {
    if (this.#svc) return Promise.resolve();
    if (this.#retry) { clearTimeout(this.#retry); this.#retry = null; }
    this.#connecting ??= this.#connect().then(
      () => { this.#retryMs = 1000; this.#lastWarn = ''; },
      (e) => { this.#warn(e); this.#schedule(); throw e; },
    ).finally(() => { this.#connecting = null; });
    return this.#connecting;
  }

  isRunning(id: string) { return !!this.#byId.get(id)?.running; }
  nameOf(id: string) { const s = this.#byId.get(id); return s?.title || s?.preview.slice(0, 40) || null; }

  addClient(c: { send: (data: string) => void; close: (code: number, reason: string) => void }): BridgeClient {
    const client: BridgeClient = { ...c, subs: new Set(), ready: Promise.resolve() };
    this.#clients.add(client);
    client.ready = this.ready().catch((e) => { client.close(1011, `opencode 서버에 연결하지 못했습니다: ${e?.message || e}`); throw e; });
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

  // ── backend REST (server.ts) ──
  async history(id: string) {
    await this.ready();
    return historyTurns(await this.#messages(id), this.#byId.get(id)?.cwd || '').slice(-HISTORY_TURNS);
  }
  async lastTurn(id: string) { return (await this.history(id)).at(-1) || null; }
  async activity() {
    await this.ready();
    return Object.fromEntries([...this.#byId.values()].filter((s) => !s.parentID).map((s) => [s.id, s.updatedAt]));
  }
  // Subagent runs (child sessions, in omo.task.updated's shape) and the context the last model call used.
  async meta(id: string) {
    await this.ready();
    const s = this.#byId.get(id);
    let usage = null;
    const r = await this.#api('GET', `/api/session/${enc(id)}/message?order=desc&limit=10&type=assistant`).catch(() => null);
    const last = (r?.data || []).find((m: any) => m.tokens);
    if (last) {
      const used = tokensUsed(last.tokens);
      const window = await this.#contextWindow(last.model || s?.model);
      if (used && window) usage = { used, window };
    }
    return { agents: this.#agentsOf(id), usage, skills: {} };
  }
  // The `/` palette: the server's commands and skills. A skill goes in as `/skill:id`, which turn/start attaches.
  async palette() {
    await this.ready();
    const [cmds, skills] = await Promise.all([this.#api('GET', '/api/command'), this.#api('GET', '/api/skill')]);
    const commands = (cmds.data || []).map((c: any) => ({ kind: 'command', name: String(c.name), desc: String(c.description || ''), source: 'builtin' }));
    this.#commands = { at: Date.now(), names: Promise.resolve(new Set(commands.map((c: any) => c.name))) };
    return [...commands, ...(skills.data || []).map((k: any) => ({ kind: 'skill', name: String(k.id), label: `/skill:${k.id}`, insert: `/skill:${k.id} `, desc: String(k.description || ''), source: 'builtin' }))];
  }

  // ── connection ──
  #warn(e: any) {
    const text = String(e?.message || e);
    if (text !== this.#lastWarn) console.warn('[opencode]', text);
    this.#lastWarn = text;
  }

  #schedule() {
    if (this.#retry) return;
    this.#retry = setTimeout(() => { this.#retry = null; this.ready().catch(() => {}); }, this.#retryMs);
    this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
  }

  async #connect() {
    const svc = await ensureService();
    const ac = new AbortController();
    const res = await fetch(`${svc.url}/api/event`, { headers: { authorization: svc.auth, accept: 'text/event-stream' }, signal: ac.signal });
    if (!res.ok || !res.body) { ac.abort(); throw new OpencodeError(`opencode 이벤트 스트림을 열지 못했습니다 (HTTP ${res.status})`); }
    Object.assign(this, { url: svc.url, version: svc.version });
    this.#svc = svc;
    this.#ac = ac;
    this.#buffer = [];
    void this.#read(res.body, ac);
    try { await this.#sync(); } catch (e) { this.#close(ac); throw e; }
    const queued = this.#buffer || [];
    this.#buffer = null;
    for (const e of queued) this.#dispatch(e);
    console.log(`[opencode] opencode ${svc.version} (${svc.url})`);
  }

  // The stream only sends what happens from now on, and nothing replays a gap, so a lost stream drops every browser
  // connection: browsers reconnect and read everything again, as they do after any lost socket. The server sends a
  // heartbeat comment, so a stream silent for 90 seconds is treated as lost.
  async #read(body: ReadableStream<Uint8Array>, ac: AbortController) {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '', last = Date.now();
    const watch = setInterval(() => { if (Date.now() - last > 90_000) ac.abort(); }, 15_000);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        last = Date.now();
        buf += dec.decode(value, { stream: true });
        for (let i; (i = buf.search(/\r?\n\r?\n/)) >= 0;) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + (buf.startsWith('\r\n\r\n', i) ? 4 : buf.startsWith('\r\n', i) || buf.startsWith('\n\r\n', i) ? 3 : 2));
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let e: any;
          try { e = JSON.parse(data); } catch { continue; }
          if (this.#buffer) this.#buffer.push(e); else this.#dispatch(e);
        }
      }
    } catch (e: any) {
      if (!ac.signal.aborted) console.warn('[opencode] 이벤트 스트림이 끊겼습니다:', e?.message || e);
    } finally {
      clearInterval(watch);
      this.#close(ac);
    }
  }

  #close(ac: AbortController) {
    if (ac !== this.#ac) return;
    ac.abort();
    this.#ac = null;
    this.#svc = null;
    this.#buffer = null;
    this.#byId.clear();
    this.#reqs.clear();
    this.#models = null;
    this.#commands = null;
    for (const c of this.#clients) c.close(1011, 'opencode 서버 연결이 끊겼습니다');
    console.warn('[opencode] opencode 서버 연결이 끊겼습니다');
    this.#schedule();
  }

  async #api(method: string, path: string, body?: unknown, ms = 30_000): Promise<any> {
    const svc = this.#svc;
    if (!svc) throw new OpencodeError('opencode 서버에 연결되어 있지 않습니다');
    const res = await fetch(`${svc.url}${path}`, {
      method, signal: AbortSignal.timeout(ms),
      headers: { authorization: svc.auth, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let why = text;
      try { const j = JSON.parse(text); why = j.message || j._tag || text; } catch {}
      throw new OpencodeError(`opencode가 요청을 거절했습니다: ${String(why).split('\n')[0].slice(0, 200) || `HTTP ${res.status}`}`, res.status);
    }
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  }

  async #sync() {
    const page = async (archived: boolean) => {
      const out: any[] = [];
      let cursor: string | null = null;
      do {
        const r = await this.#api('GET', `/api/session?limit=200&archived=${archived}${cursor ? `&cursor=${enc(cursor)}` : ''}`);
        const data = r.data || [];
        out.push(...data);
        cursor = data.length === 200 ? r.cursor?.next || null : null;
      } while (cursor);
      return out;
    };
    const [active, open, archived] = await Promise.all([this.#api('GET', '/api/session/active'), page(false), page(true)]);
    for (const info of [...open, ...archived]) this.#upsert(info);
    const running = Object.keys(active.data || {});
    for (const id of running) { const s = this.#byId.get(id); if (s) { s.running = true; s.startedAt = s.updatedAt; } }
    // Only a running session can wait for an answer.
    await Promise.all(running.filter((id) => this.#byId.has(id)).map(async (id) => {
      const [perms, forms] = await Promise.all([this.#api('GET', `/api/session/${enc(id)}/permission`), this.#api('GET', `/api/session/${enc(id)}/form`)]);
      for (const p of perms.data || []) this.#permission(p, false);
      for (const f of forms.data || []) this.#form(f, false);
    }));
  }

  #upsert(info: any): Sess {
    let s = this.#byId.get(info.id);
    if (!s) {
      s = { id: info.id, parentID: null, title: null, preview: '', previewRead: false, cwd: '', agent: null, model: null, createdAt: 0, updatedAt: 0, idleAt: null, startedAt: null,
        archived: false, outcome: null, running: false, turn: null, seq: 0, inbox: new Map(), tools: new Map(), compacting: null };
      this.#byId.set(info.id, s);
    }
    const t = info.time || {};
    Object.assign(s, {
      parentID: info.parentID || null, title: info.title || null, cwd: info.location?.directory || s.cwd, agent: info.agent || s.agent, model: info.model || s.model,
      createdAt: t.created || s.createdAt, updatedAt: Math.max(t.updated || 0, s.updatedAt), idleAt: t.idle ?? s.idleAt, archived: !!t.archived, outcome: info.outcome ?? s.outcome,
    });
    return s;
  }

  // A session the bridge has not seen yet (created by another client), announced to every dashboard.
  #fetch(id: string): Promise<Sess | null> {
    let p = this.#fetching.get(id);
    if (!p) {
      p = this.#api('GET', `/api/session/${enc(id)}`).then(async (r) => {
        const s = this.#upsert(r.data || r);
        if (s.parentID) this.#tasksChanged(s.parentID);
        else this.#notifyAll('thread/started', { thread: await this.#threadOf(s) });
        return s;
      }, (e) => { console.warn('[opencode] 세션을 읽지 못했습니다:', id, e?.message || e); return null; }).finally(() => this.#fetching.delete(id));
      this.#fetching.set(id, p);
    }
    return p;
  }

  // Desc pages until the window holds HISTORY_TURNS user messages, returned oldest first. A cursor carries its own
  // order, and the server refuses one sent with `order` as well.
  async #messages(id: string) {
    const out: any[] = [];
    let cursor: string | null = null, users = 0;
    do {
      const r = await this.#api('GET', `/api/session/${enc(id)}/message?limit=200&${cursor ? `cursor=${enc(cursor)}` : 'order=desc'}`);
      const data = r.data || [];
      out.push(...data);
      users += data.filter((m: any) => m.type === 'user').length;
      cursor = data.length === 200 ? r.cursor?.next || null : null;
    } while (cursor && users <= HISTORY_TURNS);
    return out.reverse();
  }

  #modelList() {
    if (!this.#models || Date.now() - this.#models.at > 60_000) {
      const data = this.#api('GET', '/api/model').then((r) => r.data || []);
      this.#models = { at: Date.now(), data };
      data.catch(() => { if (this.#models?.data === data) this.#models = null; });
    }
    return this.#models.data;
  }
  async #contextWindow(m: Model | null | undefined) {
    if (!m) return null;
    const hit = (await this.#modelList().catch(() => [])).find((x: any) => x.providerID === m.providerID && x.id === m.id);
    return Number(hit?.limit?.context) || null;
  }
  #commandNames() {
    if (!this.#commands || Date.now() - this.#commands.at > 10 * 60_000) {
      const names = this.#api('GET', '/api/command').then((r) => new Set<string>((r.data || []).map((c: any) => String(c.name))));
      this.#commands = { at: Date.now(), names };
      names.catch(() => { if (this.#commands?.names === names) this.#commands = null; });
    }
    return this.#commands.names;
  }

  // ── what the dashboard sees ──
  #status(s: Sess) {
    const waiting = [...this.#reqs.values()].some((r) => r.threadId === s.id);
    if (s.running || waiting) return { type: 'active', activeFlags: waiting ? ['waitingOnUserInput'] : [] };
    // The last run failed: the board files the session under errors until it runs again.
    return s.outcome === 'failed' ? { type: 'systemError' } : { type: 'idle' };
  }
  #pushStatus(s: Sess) { if (!s.parentID) this.#notifyAll('thread/status/changed', { threadId: s.id, status: this.#status(s) }); }

  async #threadOf(s: Sess) {
    // A session nobody titled is named after its first message, as omo's are.
    if (!s.title && !s.preview && !s.previewRead) {
      s.previewRead = true;
      const r = await this.#api('GET', `/api/session/${enc(s.id)}/message?order=asc&limit=1&type=user`).catch(() => null);
      const first = r?.data?.[0];
      if (first) s.preview = promptText(first).slice(0, PREVIEW_MAX);
    }
    return {
      id: s.id, name: s.title, preview: s.preview, cwd: s.cwd, path: '', source: 'appServer', status: this.#status(s),
      createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt, archived: s.archived,
    };
  }
  // A session made without a model keeps none of its own and runs on the server's default model, so that is what the
  // composer shows.
  async #opened(s: Sess) {
    const m = s.model || (await this.#defaultModel());
    return { thread: await this.#threadOf(s), model: m?.id, modelProvider: m?.providerID, reasoningEffort: m?.variant };
  }
  async #list(archived: boolean) {
    const top = [...this.#byId.values()].filter((s) => !s.parentID && s.archived === archived);
    return Promise.all(top.map((s) => this.#threadOf(s)));
  }

  #agentsOf(parentId: string) {
    return [...this.#byId.values()].filter((c) => c.parentID === parentId).sort((a, b) => a.createdAt - b.createdAt).map((c) => ({
      task_id: c.id, name: c.title || c.agent || '하위 에이전트', task_summary: c.title || '', agent_type: c.agent || 'agent', model: c.model?.id,
      ...(c.running
        ? { live_progress: { activity: '실행 중', started_at: c.startedAt } }
        : { live_progress: null, final_response: c.outcome === 'succeeded' ? '완료' : '', error_message: c.outcome === 'failed' ? '실패' : c.outcome === 'interrupted' ? '중단됨' : '',
          run_stats: { duration_ms: c.idleAt && c.createdAt ? c.idleAt - c.createdAt : undefined } }),
    }));
  }
  #tasksChanged(parentId: string) { this.#notifySubs(parentId, 'extension_event', { threadId: parentId, name: 'omo.task.updated', data: this.#agentsOf(parentId) }); }

  #send(c: BridgeClient, msg: unknown) { try { c.send(JSON.stringify(msg)); } catch {} }
  #notifyAll(method: string, params: unknown) { for (const c of this.#clients) this.#send(c, { method, params }); }
  #notifySubs(id: string, method: string, params: unknown) { for (const c of this.#clients) if (c.subs.has(id)) this.#send(c, { method, params }); }
  #subscribe(c: BridgeClient, s: Sess) {
    if (c.subs.has(s.id)) return;
    c.subs.add(s.id);
    for (const r of this.#reqs.values()) if (r.threadId === s.id) this.#send(c, r.msg);
  }
  #sess(id: string) {
    const s = this.#byId.get(id);
    if (!s) throw new OpencodeError('세션을 찾지 못했습니다');
    return s;
  }

  // ── turns and items, rebuilt from the server's session events ──
  #startTurn(s: Sess) {
    if (s.turn) return s.turn;
    s.turn = { id: `oc-${++this.#turnSeq}`, status: 'inProgress', items: [] };
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
  // The text or reasoning item of one part of an assistant message, started on first sight.
  #part(s: Sess, d: any, type: 'agentMessage' | 'reasoning') {
    const id = `${d.assistantMessageID}:${type === 'agentMessage' ? 't' : 'r'}${d.ordinal ?? 0}`;
    if (!this.#startTurn(s).items.some((x) => x.id === id)) this.#item(s, 'item/started', type === 'agentMessage' ? { type, id, text: '', status: 'inProgress' } : { type, id, content: [], status: 'inProgress' });
    return id;
  }
  #tool(s: Sess, id: string, state: any, done = false) {
    const known = s.tools.get(id);
    const prev = s.turn?.items.find((x) => x.id === id);
    const t = known || { name: prev?.tool || (prev?.type === 'commandExecution' ? 'shell' : 'tool'), input: prev?.arguments || (prev?.command ? { command: prev.command } : {}) };
    this.#item(s, done ? 'item/completed' : 'item/started', toolItem(id, t.name, t.input, state, s.cwd));
    if (done) s.tools.delete(id);
  }

  #began(s: Sess) {
    s.running = true;
    s.outcome = null;
    s.startedAt = s.updatedAt = Date.now();
    if (s.parentID) { this.#tasksChanged(s.parentID); return; }
    this.#startTurn(s);
    this.#pushStatus(s);
  }
  #settled(s: Sess, outcome: string, error?: string) {
    const was = s.running;
    Object.assign(s, { running: false, outcome, updatedAt: Date.now(), idleAt: Date.now(), compacting: null });
    s.tools.clear();
    for (const r of [...this.#reqs.values()]) if (r.threadId === s.id) this.#resolve(r);
    if (s.parentID) { s.turn = null; this.#tasksChanged(s.parentID); return; }
    if (s.turn && error) s.turn.error = { message: error };
    this.#pushStatus(s);
    if (error) this.#notifySubs(s.id, 'error', { threadId: s.id, error: { message: error }, willRetry: false });
    this.#endTurn(s, TURN_STATUS[outcome] || 'completed');
    if (was) this.emit('settled', s.id);
  }
  #drop(s: Sess) {
    this.#byId.delete(s.id);
    for (const r of [...this.#reqs.values()]) if (r.threadId === s.id) this.#resolve(r);
    if (s.parentID) { this.#tasksChanged(s.parentID); return; }
    if (s.turn) this.#endTurn(s, 'interrupted');
    this.#notifyAll('thread/deleted', { threadId: s.id });
  }

  #dispatch(e: any) {
    try { this.#event(e); } catch (err: any) { console.error('[opencode] 이벤트를 처리하지 못했습니다:', e?.type, err?.message || err); }
  }

  #event(e: any) {
    const type = String(e?.type || ''), d = e?.data || {};
    switch (type) {
      case 'permission.asked': this.#permission(d, true); return;
      case 'permission.replied': { const r = this.#reqs.get(d.requestID); if (r) this.#resolve(r); return; }
      case 'form.created': this.#form(d.form, true); return;
      case 'form.replied': case 'form.cancelled': { const r = this.#reqs.get(d.id); if (r) this.#resolve(r); return; }
      case 'model.updated': case 'provider.updated': this.#models = null; return;
      case 'command.updated': this.#commands = null; return;
    }
    if (!type.startsWith('session.') || typeof d.sessionID !== 'string') return;
    if (type === 'session.created' || type === 'session.forked') { void this.#fetch(d.sessionID); return; }
    const s = this.#byId.get(d.sessionID);
    if (!s) {
      // Created before this stream opened and missed by the list read: read it, then apply this event.
      if (type !== 'session.deleted') void this.#fetch(d.sessionID).then((x) => { if (x) this.#dispatch(e); });
      return;
    }
    switch (type) {
      case 'session.deleted': this.#drop(s); return;
      case 'session.renamed':
        s.title = d.title || null;
        if (s.parentID) this.#tasksChanged(s.parentID); else this.#notifyAll('thread/name/updated', { threadId: s.id, threadName: s.title || s.preview.slice(0, 40) });
        return;
      case 'session.archived': s.archived = true; this.#notifyAll('thread/archived', { threadId: s.id }); return;
      case 'session.unarchived': s.archived = false; this.#notifyAll('thread/unarchived', { threadId: s.id }); return;
      case 'session.model.selected':
        s.model = d.model || s.model;
        this.#notifyAll('thread/settings/updated', { threadId: s.id, threadSettings: { model: s.model?.id, modelProvider: s.model?.providerID, effort: s.model?.variant } });
        return;
      case 'session.agent.selected': s.agent = d.agent || s.agent; return;
      case 'session.execution.started': this.#began(s); return;
      case 'session.execution.succeeded': this.#settled(s, 'succeeded'); return;
      case 'session.execution.failed': this.#settled(s, 'failed', d.error?.message || '오류로 실행이 끝났습니다'); return;
      case 'session.execution.interrupted': this.#settled(s, 'interrupted'); return;
    }
    // The rest is the content of a run; a child session's run shows only in its parent's agents tab.
    if (s.parentID) return;
    switch (type) {
      case 'session.inbox.enqueued': if (d.item?.type === 'user') s.inbox.set(d.inboxID, promptText(d.item.payload)); return;
      case 'session.inbox.cancelled': s.inbox.delete(d.inboxID); return;
      // A prompt joins the conversation when it is delivered: at once when idle, between steps while running. The
      // message keeps the inbox id, which is how history names it too.
      case 'session.inbox.delivered': {
        const text = s.inbox.get(d.inboxID);
        if (text == null) return;
        s.inbox.delete(d.inboxID);
        this.#item(s, 'item/completed', { type: 'userMessage', id: d.inboxID, status: 'completed', content: [{ type: 'text', text }] });
        if (!s.title && !s.preview) { s.preview = text.slice(0, PREVIEW_MAX); s.previewRead = true; void this.#threadOf(s).then((thread) => this.#notifyAll('thread/started', { thread })); }
        return;
      }
      case 'session.text.started': this.#part(s, d, 'agentMessage'); return;
      case 'session.text.delta': {
        const id = this.#part(s, d, 'agentMessage');
        const it = s.turn!.items.find((x) => x.id === id);
        it.text = `${it.text || ''}${d.delta || ''}`;
        this.#notifySubs(s.id, 'item/agentMessage/delta', { threadId: s.id, turnId: s.turn!.id, itemId: id, delta: d.delta || '' });
        return;
      }
      case 'session.text.ended': {
        const id = this.#part(s, d, 'agentMessage');
        this.#item(s, 'item/completed', { type: 'agentMessage', id, text: d.text ?? s.turn!.items.find((x) => x.id === id)?.text ?? '', status: 'completed' });
        return;
      }
      case 'session.reasoning.started': this.#part(s, d, 'reasoning'); return;
      case 'session.reasoning.delta': {
        const id = this.#part(s, d, 'reasoning');
        const it = s.turn!.items.find((x) => x.id === id);
        it.content = [`${it.content?.[0] || ''}${d.delta || ''}`];
        this.#notifySubs(s.id, 'item/reasoning/textDelta', { threadId: s.id, turnId: s.turn!.id, itemId: id, delta: d.delta || '', contentIndex: 0 });
        return;
      }
      case 'session.reasoning.ended': {
        const id = this.#part(s, d, 'reasoning');
        this.#item(s, 'item/completed', { type: 'reasoning', id, content: [d.text ?? s.turn!.items.find((x) => x.id === id)?.content?.[0] ?? ''], status: 'completed' });
        return;
      }
      case 'session.tool.input.started': s.tools.set(d.id, { name: String(d.name || 'tool'), input: {} }); this.#tool(s, d.id, { status: 'pending' }); return;
      case 'session.tool.called': {
        const t = s.tools.get(d.id) || { name: String(d.name || 'tool'), input: {} };
        s.tools.set(d.id, { ...t, input: d.input ?? t.input });
        this.#tool(s, d.id, { status: 'running' });
        return;
      }
      case 'session.tool.success': this.#tool(s, d.id, { status: 'completed', content: d.content, metadata: d.metadata }, true); return;
      case 'session.tool.failed': this.#tool(s, d.id, { status: 'error', error: d.error, content: d.content, metadata: d.metadata }, true); return;
      // Each model call reports the tokens it sent and got back: the context the session now holds.
      case 'session.step.ended': {
        const used = tokensUsed(d.tokens);
        if (used) void this.#contextWindow(s.model).then((window) => { if (window) this.#notifySubs(s.id, 'thread/tokenUsage/updated', { threadId: s.id, tokenUsage: { total: { totalTokens: used }, modelContextWindow: window } }); });
        return;
      }
      case 'session.step.failed': if (s.turn && d.error && d.error.type !== 'aborted') s.turn.error = { message: String(d.error.message || '오류') }; return;
      case 'session.retry.scheduled':
        this.#notifySubs(s.id, 'error', { threadId: s.id, error: { message: `${d.error?.message || '오류'} · ${d.attempt || 1}번째 다시 시도합니다` }, willRetry: true });
        return;
      case 'session.compaction.started': {
        s.compacting = { id: `${s.id}:c${++s.seq}`, own: !s.turn };
        this.#item(s, 'item/started', { type: 'contextCompaction', id: s.compacting.id, status: 'inProgress' });
        return;
      }
      case 'session.compaction.ended': case 'session.compaction.failed': {
        const c = s.compacting;
        if (!c) return;
        s.compacting = null;
        this.#item(s, 'item/completed', { type: 'contextCompaction', id: c.id, status: type.endsWith('failed') ? 'failed' : 'completed' });
        if (c.own && !s.running) this.#endTurn(s, 'completed');
        return;
      }
      // A command the user ran with `!` in another client.
      case 'session.shell.started': case 'session.shell.ended': {
        const sh = d.shell || {};
        if (!sh.id) return;
        const done = type.endsWith('ended');
        this.#item(s, done ? 'item/completed' : 'item/started', {
          type: 'commandExecution', id: sh.id, command: String(sh.command || ''), cwd: sh.cwd || s.cwd, aggregatedOutput: clip(d.output?.output || ''),
          exitCode: typeof sh.exit === 'number' ? sh.exit : null, status: !done ? 'inProgress' : sh.status === 'exited' || sh.status === 'running' ? 'completed' : 'interrupted',
        });
        if (done && !s.running) this.#endTurn(s, 'completed');
        return;
      }
    }
  }

  // ── permissions and forms → server requests ──
  #permission(p: any, fresh: boolean) {
    const s = p?.sessionID && this.#byId.get(p.sessionID);
    if (!s || this.#reqs.has(p.id)) return;
    const file = FILE_ACTIONS.has(p.action);
    const resources: string[] = (p.resources || []).map(String);
    const reason = [`${ACTION_KO[p.action] || p.action} 권한을 요청합니다`, p.message, p.save?.length && `'세션 동안 허용'을 누르면 opencode가 ${p.save.join(', ')} 규칙을 저장합니다`].filter(Boolean).join(' · ');
    const params = {
      threadId: s.id, turnId: s.turn?.id || '', itemId: p.source?.id || p.id, reason,
      ...(file ? { changes: resources.map((path) => ({ path, kind: 'update', diff: '' })) } : { command: resources.join('\n') || p.action }),
    };
    this.#ask({ id: p.id, threadId: s.id, kind: 'permission', msg: { id: p.id, method: file ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval', params } },
      fresh && { kind: 'approval', text: resources.join(' ') || reason });
  }
  #form(f: any, fresh: boolean) {
    const s = f?.sessionID && this.#byId.get(f.sessionID);
    if (!s || this.#reqs.has(f.id)) return;
    const questions = formQuestions(f);
    const params = { threadId: s.id, turnId: s.turn?.id || '', itemId: f.metadata?.tool?.id || f.id, questions, waitForAnswer: true };
    this.#ask({ id: f.id, threadId: s.id, kind: 'form', form: f, msg: { id: f.id, method: 'item/tool/requestUserInput', params } },
      fresh && { kind: 'question', text: questions[0]?.question || f.title || '' });
  }
  #ask(r: Req, alert: false | { kind: 'question' | 'approval'; text: string }) {
    this.#reqs.set(r.id, r);
    for (const c of this.#clients) if (c.subs.has(r.threadId)) this.#send(c, r.msg);
    const s = this.#byId.get(r.threadId);
    if (s) this.#pushStatus(s);
    if (alert) this.emit('question', { threadId: r.threadId, requestId: r.id, ...alert });
  }
  #resolve(r: Req) {
    if (!this.#reqs.delete(r.id)) return;
    this.#notifyAll('serverRequest/resolved', { threadId: r.threadId, requestId: r.id });
    const s = this.#byId.get(r.threadId);
    if (s) this.#pushStatus(s);
  }
  async #answer(id: string, result: any) {
    const r = this.#reqs.get(id);
    if (!r) return;
    const base = `/api/session/${enc(r.threadId)}`;
    try {
      if (r.kind === 'permission') await this.#api('POST', `${base}/permission/${enc(id)}/reply`, { decision: DECISION[result?.decision] || 'reject' });
      else {
        const answer = formAnswer(r.form, result);
        if (Object.keys(answer).length) await this.#api('POST', `${base}/form/${enc(id)}/reply`, { answer });
        else await this.#api('DELETE', `${base}/form/${enc(id)}`);
      }
    } catch (e: any) {
      // The dashboard already put the card away; it comes back so the answer can be given again.
      console.warn('[opencode] 답을 보내지 못했습니다:', e?.message || e);
      this.#notifySubs(r.threadId, 'error', { threadId: r.threadId, error: { message: `답을 보내지 못했습니다: ${e?.message || e}` }, willRetry: false });
      if (this.#reqs.has(id)) for (const c of this.#clients) if (c.subs.has(r.threadId)) this.#send(c, r.msg);
    }
  }

  // A prompt that starts with a server command runs that command; leading `/skill:id` tokens attach skills.
  async #prompt(s: Sess, text: string) {
    const steer = s.running ? { delivery: 'steer' } : {};
    const cmd = text.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (cmd && !cmd[1].startsWith('skill:') && (await this.#commandNames().catch(() => new Set<string>())).has(cmd[1])) {
      await this.#api('POST', `/api/session/${enc(s.id)}/command`, { name: cmd[1], text: cmd[2] || '', ...steer });
    } else {
      const skills: { id: string }[] = [];
      let body = text, m;
      while ((m = body.match(/^\/skill:(\S+)(?:\s+|$)/))) { skills.push({ id: m[1] }); body = body.slice(m[0].length); }
      await this.#api('POST', `/api/session/${enc(s.id)}/prompt`, { text: body, ...(skills.length && { skills }), ...steer });
    }
    return { turn: { id: s.turn?.id || '', status: 'inProgress' } };
  }

  async #defaultModel(): Promise<Model | null> {
    const r = await this.#api('GET', '/api/model/default').catch(() => null);
    return r?.data ? { id: r.data.id, providerID: r.data.providerID } : null;
  }

  // ── app-server requests ──
  async #call(c: BridgeClient, method: string, p: any): Promise<unknown> {
    const id = String(p.threadId || '');
    switch (method) {
      case 'initialize': return { userAgent: `omonitor-opencode/${this.version}`, serverInfo: { name: 'opencode', version: this.version } };
      case 'thread/list': return { data: await this.#list(!!p.archived), nextCursor: null };
      // Every session lives in the server, so "loaded" means the ones the dashboard should follow right away.
      case 'thread/loaded/list': return { data: [...this.#byId.values()].filter((s) => !s.parentID && (s.running || [...this.#reqs.values()].some((r) => r.threadId === s.id))).map((s) => s.id) };
      case 'model/list': return {
        data: (await this.#modelList()).filter((m: any) => m.enabled !== false).map((m: any) => ({
          id: `${m.providerID}/${m.id}`, model: m.id, displayName: m.name || m.id, hidden: false, isDefault: false,
          defaultReasoningEffort: (m.variants || []).some((v: any) => v.id === 'medium') ? 'medium' : m.variants?.[0]?.id || '',
          supportedReasoningEfforts: (m.variants || []).map((v: any) => ({ reasoningEffort: String(v.id), description: '' })),
        })),
      };
      case 'thread/read': {
        const s = this.#sess(id);
        return { thread: { ...(await this.#threadOf(s)), turns: p.includeTurns && s.turn ? [{ ...s.turn, items: [...s.turn.items] }] : [] } };
      }
      case 'thread/resume': { const s = this.#sess(id); this.#subscribe(c, s); return this.#opened(s); }
      case 'thread/unsubscribe': c.subs.delete(id); return {};
      case 'thread/start': {
        const [providerID, ...rest] = typeof p.model === 'string' ? p.model.split('/') : [];
        const base = rest.length ? { id: rest.join('/'), providerID } : p.effort ? await this.#defaultModel() : null;
        const model = base && { ...base, ...(p.effort && { variant: String(p.effort) }) };
        const r = await this.#api('POST', '/api/session', { location: { directory: p.cwd }, ...(model && { model }) });
        const s = this.#upsert(r.data || r);
        this.#subscribe(c, s);
        const out = await this.#opened(s);
        for (const o of this.#clients) if (o !== c) this.#send(o, { method: 'thread/started', params: { thread: out.thread } });
        return out;
      }
      case 'turn/start': { const s = this.#sess(id); this.#subscribe(c, s); return this.#prompt(s, inputText(p.input)); }
      case 'turn/steer': {
        const s = this.#sess(id);
        this.#subscribe(c, s);
        await this.#prompt(s, inputText(p.input));
        return { turnId: s.turn?.id || p.expectedTurnId || '' };
      }
      case 'turn/interrupt': await this.#api('POST', `/api/session/${enc(id)}/interrupt`); return {};
      // A model switch without an effort lets the server pick the new model's default variant.
      case 'thread/settings/update': {
        const s = this.#sess(id);
        const cur = s.model || (await this.#defaultModel());
        const [providerID, ...rest] = p.model ? String(p.model).split('/') : [];
        if (p.model && !rest.length) throw new OpencodeError(`모델은 provider/id 형식이어야 합니다: ${p.model}`);
        const base = p.model ? { id: rest.join('/'), providerID } : cur;
        if (!base) throw new OpencodeError('바꿀 모델을 찾지 못했습니다');
        const variant = p.effort || (p.model ? undefined : cur?.variant);
        const model = { id: base.id, providerID: base.providerID, ...(variant && { variant: String(variant) }) };
        await this.#api('POST', `/api/session/${enc(id)}/model`, { model });
        s.model = model;
        this.#notifyAll('thread/settings/updated', { threadId: id, threadSettings: { model: model.id, modelProvider: model.providerID, effort: model.variant } });
        return {};
      }
      case 'thread/name/set': {
        const s = this.#sess(id);
        await this.#api('PATCH', `/api/session/${enc(id)}`, { title: String(p.name || '') });
        s.title = String(p.name || '') || null;
        this.#notifyAll('thread/name/updated', { threadId: id, threadName: s.title });
        return {};
      }
      case 'thread/compact/start':
        this.#api('POST', `/api/session/${enc(id)}/compact`, {}, 120_000).catch((e) => this.#notifySubs(id, 'error', { threadId: id, error: { message: `압축하지 못했습니다: ${e?.message || e}` } }));
        return {};
      case 'thread/goal/get': return { goal: null };
      case 'thread/goal/set': case 'thread/goal/clear': throw new OpencodeError('opencode에는 목표(goal) 기능이 없습니다');
      case 'thread/archive': case 'thread/unarchive': {
        const s = this.#sess(id);
        const archived = method === 'thread/archive';
        await this.#api('PATCH', `/api/session/${enc(id)}`, { archived });
        s.archived = archived;
        this.#notifyAll(archived ? 'thread/archived' : 'thread/unarchived', { threadId: id });
        return {};
      }
      case 'thread/delete': {
        const s = this.#sess(id);
        if (s.running) throw new OpencodeError('작업 중인 세션은 삭제할 수 없습니다');
        await this.#api('DELETE', `/api/session/${enc(id)}`);
        if (this.#byId.get(id) === s) this.#drop(s);
        return {};
      }
      case 'thread/fork': {
        const r = await this.#api('POST', `/api/session/${enc(id)}/fork`, {});
        const s = this.#upsert(r.data || r);
        this.#subscribe(c, s);
        return this.#opened(s);
      }
    }
    throw Object.assign(new OpencodeError(`opencode 연동에서 지원하지 않는 요청입니다: ${method}`), { rpcCode: -32601 });
  }
}

// Tokens a model call sent (fresh and cached) plus what it wrote back.
const tokensUsed = (t: any) => (t ? (t.input || 0) + (t.output || 0) + (t.cache?.read || 0) + (t.cache?.write || 0) : 0);
