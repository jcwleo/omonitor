// omonitor local backend — static files + WS relay to `omo app-server`, bound to 127.0.0.1 only.
//   bun server.ts          # real mode: relays to ws://127.0.0.1:18800 with the token file
//   bun server.ts --mock   # UI runs on the in-browser simulator (no app-server needed)
// Env: PORT (4800), OMO_APP_SERVER_URL, OMO_WS_TOKEN_FILE, OMONITOR_ORIGINS
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT || 4800);
const HOST = '127.0.0.1';
const UPSTREAM = process.env.OMO_APP_SERVER_URL || 'ws://127.0.0.1:18800';
const AGENT_DIR = join(homedir(), '.omo/agent');
const TOKEN_FILE = process.env.OMO_WS_TOKEN_FILE || join(AGENT_DIR, 'app-server/ws-token');
const ROOT = import.meta.dir;
const ENTRY = '/Mission Control.dc.html';
const KEY = crypto.randomUUID();
// OMONITOR_ORIGINS: extra allowed origins (comma-separated), e.g. a reverse-proxy/tunnel hostname in front of this port.
const EXTRA_ORIGINS = (process.env.OMONITOR_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, ...EXTRA_ORIGINS]);

const originOk = (req: Request) => { const o = req.headers.get('origin'); return !o || ORIGINS.has(o); };
const keyOk = (req: Request, url: URL) => (url.searchParams.get('key') || req.headers.get('x-mc-key')) === KEY;
const readToken = async () => (await readFile(TOKEN_FILE, 'utf8')).trim();

// ── short-lived app-server connection (thread lookups for the history endpoints) ──
async function withRpc<T>(fn: (call: (method: string, params: unknown) => Promise<any>) => Promise<T>): Promise<T> {
  const token = await readToken();
  const ws = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${token}` } } as any);
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  let seq = 0;
  const opened = new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('app-server에 연결하지 못했습니다')); });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    const p = m.id != null ? pending.get(m.id) : undefined;
    if (!p || !('result' in m || 'error' in m)) return;
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  };
  ws.onclose = () => { for (const p of pending.values()) p.rej(new Error('app-server 연결이 끊겼습니다')); pending.clear(); };
  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error('app-server 응답 시간 초과')); }, 8000);
    pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    await opened;
    await call('initialize', { clientInfo: { name: 'omonitor-backend', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    return await fn(call);
  } finally { ws.close(); }
}

// thread/read and thread/resume load the session into the app-server, where omo may auto-continue a pending goal or
// todo list. thread/list only reads the session index, so the file path is looked up there.
async function threadPath(threadId: string): Promise<string | null> {
  return withRpc(async (call) => {
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const r = await call('thread/list', { archived, cursor, limit: 100 });
        const hit = (r?.data || []).find((t: any) => t.id === threadId);
        if (hit) return hit.path || null;
        cursor = r?.nextCursor ?? null;
      } while (cursor);
    }
    return null;
  });
}

// ── models that app-server's model/list leaves out ──
// model/list reads the process-wide model registry, which never sees providers registered by builtin extensions.
// anthropic-subscription (Claude subscription login) is the one such provider, so its models are missing even though
// thread/settings/update accepts them. They are rebuilt here the way the extension builds them: the pi-ai anthropic
// catalog with the minimal level removed, taken from the pi-ai copy inside the installed omo.
const SUBSCRIPTION = 'anthropic-subscription';
let piAi: Promise<{ core: any; compat: any }> | null = null;
async function loadPiAi() {
  const bin = Bun.which('omo');
  if (!bin) throw new Error('PATH에서 omo를 찾지 못했습니다');
  let entry = await realpath(bin);
  const shim = (await readFile(entry, 'utf8')).match(/^# entry: (.+)$/m); // omo-ai's bun launcher shim
  if (shim) entry = shim[1].trim();
  const from = dirname(Bun.resolveSync('@code-yeongyu/senpi', dirname(entry)));
  return { core: await import(Bun.resolveSync('@earendil-works/pi-ai', from)), compat: await import(Bun.resolveSync('@earendil-works/pi-ai/compat', from)) };
}
async function extraModels() {
  const auth = JSON.parse(await readFile(join(AGENT_DIR, 'auth.json'), 'utf8').catch(() => '{}'));
  if (!auth[SUBSCRIPTION] && !auth['claude-sdk-oauth']) return []; // claude-sdk-oauth: the provider's earlier auth key
  const { core, compat } = await (piAi ??= loadPiAi().catch((e) => { piAi = null; throw e; }));
  return compat.getModels('anthropic').map((m: any) => {
    const model = { ...m, provider: SUBSCRIPTION, thinkingLevelMap: { ...m.thinkingLevelMap, minimal: null } };
    const levels: string[] = m.reasoning ? core.getSupportedThinkingLevels(model).filter((l: string) => l !== 'off') : [];
    return { id: `${SUBSCRIPTION}/${m.id}`, model: m.id, displayName: m.name ?? m.id, hidden: false, supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort, description: '' })), defaultReasoningEffort: 'medium', isDefault: false };
  });
}

// ── skills: builtin + SKILL.md folders (same precedence as omo) ──
const BUILTIN = [
  ...[['goal', '세션 목표 설정·조회·일시정지·해제'], ['ulw-execute', 'Prometheus 계획으로 Atlas 실행 시작'], ['refactor', 'LSP·AST-grep 기반 리팩터링 + TDD 검증'], ['handoff', '새 세션으로 넘길 인계 요약 작성'], ['stop-continuation', 'todo 이어가기·목표 등 자동 진행 모두 중단'], ['remove-ai-slops', '브랜치 변경에서 AI 티 나는 코드 정리'], ['hyperplan', '팀 모드 적대적 계획 (team_mode 필요)']].map(([name, desc]) => ({ kind: 'command', name, desc, source: 'builtin' })),
  ...[['git-master', '원자적 커밋 · 리베이스 · 이력 추적'], ['review-work', '구현 후 실제 화면 QA + 게이트 리뷰'], ['ulw-research', '출처 인용이 필요한 최대 포화 리서치'], ['frontend', 'UI/UX 구현 · 스타일링'], ['playwright', '브라우저 자동화 · 스크린샷 검증'], ['debugging', '재현 → 원인 추적 → 수정 검증'], ['security-review', '변경 사항 보안 검토'], ['init-deep', '폴더별 AGENTS.md 계층 생성']].map(([name, desc]) => ({ kind: 'skill', name, desc, source: 'builtin' })),
  { kind: 'keyword', name: 'ulw', insert: 'ulw ', label: 'ultrawork · ulw', desc: '어려운 작업: 코드 파악 → 계획 → 단계별 검증', source: 'builtin' },
  { kind: 'keyword', name: 'mass ulw', insert: 'mass ulw ', label: 'mass ulw', desc: '작업을 에이전트 그래프로 나눠 병렬 실행', source: 'builtin' },
];
function frontmatter(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (m) for (const line of m[1].split('\n')) { const kv = line.match(/^(\w[\w-]*):\s*(.*)$/); if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, ''); }
  return out;
}
async function listSkills(cwd?: string) {
  const H = homedir();
  const dirs = [
    cwd && join(cwd, '.opencode/skills'), join(H, '.config/opencode/skills'),
    cwd && join(cwd, '.claude/skills'), join(H, '.claude/skills'),
    cwd && join(cwd, '.agents/skills'), join(H, '.agents/skills'),
  ].filter(Boolean) as string[];
  const seen = new Set<string>();
  const user: any[] = [];
  for (const d of dirs) {
    let names: string[] = [];
    try { names = await readdir(d); } catch { continue; }
    for (const n of names) {
      try {
        const md = await readFile(join(d, n, 'SKILL.md'), 'utf8');
        const fm = frontmatter(md);
        const name = fm.name || n;
        if (seen.has(name)) continue;
        seen.add(name);
        user.push({ kind: 'skill', name, desc: `${fm.description || ''} (${d.replace(H, '~')})`.trim(), source: 'user' });
      } catch {}
    }
  }
  return [...BUILTIN.filter((b) => !seen.has(b.name)), ...user];
}

// ── history from the session JSONL (docs/session-format.md), without loading the session ──
const HISTORY_TURNS = 60;
const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n}자 생략)` : s);
const textOf = (content: any): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
// app-server names a new session's file at thread/start but writes it only once something is recorded, so a session
// with nothing sent yet has no file: that is an empty session, not an error.
const readSession = (path: string) => readFile(path, 'utf8').catch((e: any) => (e?.code === 'ENOENT' ? '' : Promise.reject(e)));
// Follows the latest entry's parent chain (the active branch) and starts one turn per user message.
async function parseHistory(path: string) {
  const entries = new Map<string, any>();
  let leaf: string | null = null;
  for (const line of (await readSession(path)).split('\n')) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e?.id || e.type === 'session') continue;
    entries.set(e.id, e);
    leaf = e.id;
  }
  const chain: any[] = [];
  const seen = new Set<string>();
  for (let id = leaf; id && entries.has(id) && !seen.has(id); id = entries.get(id).parentId) { seen.add(id); chain.push(entries.get(id)); }
  chain.reverse();
  const turns: any[] = [];
  const calls = new Map<string, any>();
  let cur: any = null;
  const turn = (id: string) => (cur = turns[turns.push({ id: `file-${id}`, status: 'completed', items: [] }) - 1]);
  const push = (item: any) => (cur || turn(item.id)).items.push(item);
  // lastAt (ms): when the turn's latest message was written, shown at the end of the turn in the timeline.
  const stamp = (e: any) => { const at = Date.parse(e.timestamp); if (cur && at) cur.lastAt = at; };
  for (const e of chain) {
    if (e.type === 'compaction') { push({ type: 'contextCompaction', id: e.id, status: 'completed' }); stamp(e); continue; }
    if (e.type !== 'message' || !e.message) continue;
    const m = e.message;
    if (m.role === 'user') { turn(e.id).items.push({ type: 'userMessage', id: e.id, content: [{ type: 'text', text: textOf(m.content) }] }); stamp(e); continue; }
    if (m.role === 'assistant') {
      (m.content || []).forEach((b: any, k: number) => {
        if (b?.type === 'text' && b.text?.trim()) push({ type: 'agentMessage', id: `${e.id}:${k}`, text: b.text, status: 'completed' });
        else if (b?.type === 'toolCall') {
          const it = { type: 'dynamicToolCall', id: b.id || `${e.id}:${k}`, tool: b.name, arguments: b.arguments ?? {}, status: 'completed', success: true, contentItems: [] as any[] };
          calls.set(it.id, it);
          push(it);
        }
      });
      if (cur) {
        delete cur.error;
        cur.status = m.stopReason === 'error' ? 'failed' : m.stopReason === 'aborted' ? 'interrupted' : 'completed';
        if (m.stopReason === 'error') cur.error = { message: m.errorMessage || '오류로 턴이 끝났습니다' };
      }
      stamp(e);
      continue;
    }
    if (m.role === 'toolResult') {
      const it = calls.get(m.toolCallId);
      if (it) Object.assign(it, { success: !m.isError, status: m.isError ? 'failed' : 'completed', contentItems: [{ type: 'inputText', text: clip(textOf(m.content)) }] });
      continue;
    }
    if (m.role === 'bashExecution') { push({ type: 'commandExecution', id: e.id, command: m.command, aggregatedOutput: clip(m.output || ''), exitCode: m.exitCode ?? null, status: m.cancelled ? 'interrupted' : 'completed' }); stamp(e); }
  }
  return turns;
}
async function readHistory(threadId: string) {
  const path = await threadPath(threadId);
  return path ? (await parseHistory(path)).slice(-HISTORY_TURNS) : [];
}
// Todo calls across the whole session, for threads whose app-server history lost its tool items after a restart.
async function restoreTodos(threadId: string) {
  const path = await threadPath(threadId);
  if (!path) return [];
  const turns = await parseHistory(path);
  return turns.flatMap((u) => u.items).filter((i) => i.type === 'dynamicToolCall' && i.tool === 'todo' && typeof i.arguments?.op === 'string').map((i) => ({ ...i, id: `restored-${i.id}` }));
}

// Last conversation time per session. app-server's updatedAt follows the file's last entry, and loading a session
// appends metadata (e.g. a pi-rules.scan entry), so every session loaded at once shows the same "updated" time.
// Only message and compaction entries count; the tail is read first and widened when it holds none.
const ACTIVITY_TAIL = 256 * 1024;
async function lastTalkAt(path: string): Promise<number | null> {
  const f = Bun.file(path);
  const size = f.size;
  for (let n = ACTIVITY_TAIL; ; n *= 4) {
    const start = Math.max(0, size - n);
    const lines = (await f.slice(start, size).text()).split('\n');
    if (start > 0) lines.shift(); // cut mid-line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"message"') && !lines[i].includes('"type":"compaction"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const at = (e.type === 'message' || e.type === 'compaction') && Date.parse(e.timestamp);
        if (at) return at;
      } catch {}
    }
    if (start === 0) return null;
  }
}
async function activityTimes() {
  const threads = await withRpc(async (call) => {
    const out: any[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do { const r = await call('thread/list', { archived, cursor, limit: 100 }); out.push(...(r?.data || [])); cursor = r?.nextCursor ?? null; } while (cursor);
    }
    return out;
  });
  const times: Record<string, number> = {};
  await Promise.all(threads.filter((t) => t.path).map(async (t) => {
    try { const at = await lastTalkAt(t.path); if (at) times[t.id] = at; } catch (e: any) { console.warn(`[activity] ${t.path}: ${e?.message || e}`); }
  }));
  return times;
}

// ── subagent runs and context usage, from the session file ──
// app-server sends neither (no omo.task.updated events, no thread/tokenUsage/updated), but the file records every task
// spawn (task tool result details), completion (senpi-task.completion) and model response usage.
// The shape matches omo.task.updated so the store's parseTasks reads both.
function spawnedTask(d: any, at: string) {
  return {
    task_id: d.task_id, name: d.name, task_summary: d.task_summary, agent_type: d.subagent_type ?? d.agent_type, category: d.category,
    model: d.resolved_model?.display ?? d.model, live_progress: { activity: '실행 중', started_at: Date.parse(at) || null },
  };
}
function finishedTask(d: any) {
  const ok = d.status === 'completed';
  return {
    task_id: d.task_id, name: d.name, agent_type: d.agent_type, category: d.category, model: d.resolved_model?.display ?? d.model, live_progress: null,
    final_response: ok ? String(d.final_response || '완료') : '', error_message: ok ? '' : String(d.error_message || d.error || (d.status === 'cancelled' ? '취소됨' : d.status || '실패')),
    run_stats: { duration_ms: d.duration_ms, tool_calls: d.run_stats?.tool_calls },
  };
}
async function contextWindow(provider: string, model: string): Promise<number | null> {
  try {
    const { compat } = await (piAi ??= loadPiAi().catch((e) => { piAi = null; throw e; }));
    const find = (p: string) => { try { return compat.getModels(p).find((m: any) => m.id === model); } catch { return undefined; } };
    const hit = find(provider) || find(provider.replace(/-subscription$/, '')) || compat.getProviders().map(find).find(Boolean);
    return hit?.contextWindow || null;
  } catch { return null; }
}
async function threadMeta(threadId: string) {
  const path = await threadPath(threadId);
  if (!path) return { agents: [], usage: null };
  const agents = new Map<string, any>();
  let last: any = null;
  for (const line of (await readSession(path)).split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"toolName":"task"') && !line.includes('senpi-task.completion') && !line.includes('"type":"compaction"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type === 'compaction') last = null; // the next response reports the compacted context
    else if (m?.role === 'assistant' && m.usage) last = m;
    else if (m?.role === 'toolResult' && m.toolName === 'task' && m.details) {
      for (const d of m.details.items || [m.details]) if (d?.task_id) agents.set(d.task_id, { ...agents.get(d.task_id), ...spawnedTask(d, e.timestamp) });
    } else if (e.type === 'custom_message' && Array.isArray(e.details)) {
      for (const c of e.details) if (c?.customType === 'senpi-task.completion') for (const d of c.details || []) if (d?.task_id) agents.set(d.task_id, { ...agents.get(d.task_id), ...finishedTask(d) });
    }
  }
  let usage = null;
  if (last) {
    const u = last.usage;
    const used = u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    const window = used ? await contextWindow(String(last.provider || ''), String(last.model || '')) : null;
    if (used && window) usage = { used, window };
  }
  return { agents: [...agents.values()], usage };
}

// ── pasted images ──
// app-server's turn input rejects image items, so a pasted image is saved here and its path goes into the message
// text; the agent opens it with its read tool. Names are random UUIDs, which is what lets <img> load them without a key.
const UPLOADS = join(homedir(), '.omonitor/uploads');
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_UPLOAD = 20 * 1024 * 1024;
const UPLOAD_PATH = /^\/uploads\/([0-9a-f-]{36}\.(?:png|jpg|gif|webp))$/;
async function saveUpload(req: Request) {
  const ext = IMAGE_EXT[(req.headers.get('content-type') || '').split(';')[0].trim()];
  if (!ext) return new Response('png, jpeg, gif, webp 이미지만 첨부할 수 있습니다', { status: 415 });
  const tooBig = new Response(`이미지는 ${MAX_UPLOAD / 1024 / 1024}MB 이하만 첨부할 수 있습니다`, { status: 413 });
  if (Number(req.headers.get('content-length') || 0) > MAX_UPLOAD) return tooBig;
  const body = await req.arrayBuffer();
  if (!body.byteLength) return new Response('빈 이미지입니다', { status: 400 });
  if (body.byteLength > MAX_UPLOAD) return tooBig;
  await mkdir(UPLOADS, { recursive: true });
  const name = `${crypto.randomUUID()}.${ext}`;
  const path = join(UPLOADS, name);
  await Bun.write(path, body);
  return Response.json({ path, url: `/uploads/${name}` });
}

// ── static files (only the assets used by the dashboard) ──
const STATIC = new Set([
  ENTRY, '/support.js', '/app/real-client.js', '/app/mock-client.js', '/app/store.js', '/app/styles.css',
  '/McSessionCard.dc.html', '/McRequestCard.dc.html', '/McItem.dc.html', '/McComposer.dc.html',
  '/manifest.webmanifest', '/app/icon-180.png', '/app/icon-512.png',
]);
async function serveStatic(pathname: string) {
  if (!STATIC.has(decodeURIComponent(pathname))) return new Response('not found', { status: 404 });
  const p = join(ROOT, decodeURIComponent(pathname));
  try { const s = await stat(p); if (!s.isFile()) throw 0; } catch { return new Response('not found', { status: 404 }); }
  return new Response(Bun.file(p), { headers: { 'cache-control': 'no-store' } });
}

type Data = { up?: WebSocket; queue: string[] };
Bun.serve<Data>({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (!originOk(req)) return new Response('forbidden origin', { status: 403 });
    if (url.pathname === '/') return Response.redirect(encodeURI(ENTRY), 302);
    if (url.pathname === '/api/config') {
      if (req.headers.get('sec-fetch-site') === 'cross-site') return new Response('forbidden', { status: 403 });
      return Response.json({ mode: MOCK ? 'mock' : 'real', key: KEY, upstream: UPSTREAM });
    }
    if (url.pathname === '/ws') {
      if (MOCK) return new Response('mock mode', { status: 404 });
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      return server.upgrade(req, { data: { queue: [] } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    const up = url.pathname.match(UPLOAD_PATH);
    if (up) {
      const f = Bun.file(join(UPLOADS, up[1]));
      return (await f.exists()) ? new Response(f, { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }) : new Response('not found', { status: 404 });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      if (url.pathname === '/api/uploads' && req.method === 'POST') return await saveUpload(req).catch((e) => new Response(String(e?.message || e), { status: 500 }));
      try {
        if (url.pathname === '/api/skills') return Response.json(await listSkills(url.searchParams.get('cwd') || undefined));
        if (url.pathname === '/api/models/extra') return Response.json(await extraModels());
        if (url.pathname === '/api/threads/activity' && req.method === 'GET') return Response.json(await activityTimes());
        const h = url.pathname.match(/^\/api\/threads\/([^/]+)\/history$/);
        if (h && req.method === 'GET') return Response.json(await readHistory(decodeURIComponent(h[1])));
        const mt = url.pathname.match(/^\/api\/threads\/([^/]+)\/meta$/);
        if (mt && req.method === 'GET') return Response.json(await threadMeta(decodeURIComponent(mt[1])));
        const m = url.pathname.match(/^\/api\/threads\/([^/]+)\/restore-todos$/);
        if (m && req.method === 'POST') return Response.json(await restoreTodos(decodeURIComponent(m[1])));
      } catch (e: any) { return new Response(String(e?.message || e), { status: 500 }); }
      return new Response('not found', { status: 404 });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    async open(ws) {
      let token = '';
      try { token = await readToken(); } catch { ws.close(1011, `토큰 파일을 읽지 못했습니다: ${TOKEN_FILE}`); return; }
      // Bun's client WebSocket can send headers and sends no Origin — both required by app-server.
      const up = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${token}` } } as any);
      ws.data.up = up;
      up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
      up.onmessage = (e) => ws.send(String(e.data));
      up.onclose = (e) => ws.close(1011, `app-server 연결 종료 (${e.code})`);
      up.onerror = () => ws.close(1011, 'app-server에 연결하지 못했습니다');
    },
    message(ws, msg) {
      const up = ws.data.up;
      if (up && up.readyState === WebSocket.OPEN) up.send(String(msg));
      else ws.data.queue.push(String(msg));
    },
    close(ws) { try { ws.data.up?.close(); } catch {} },
  },
});

console.log(`omonitor → http://${HOST}:${PORT}  (${MOCK ? 'mock 시뮬레이터' : `app-server ${UPSTREAM}`})`);
