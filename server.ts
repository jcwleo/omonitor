// omonitor local backend — static files + WS relay to `omo app-server`, bound to 127.0.0.1 only.
//   bun server.ts          # real mode: relays to ws://127.0.0.1:18800 with the token file
//   bun server.ts --mock   # UI runs on the in-browser simulator (no app-server needed)
// Env: PORT (4800), OMO_APP_SERVER_URL, OMO_WS_TOKEN_FILE, OMONITOR_ORIGINS
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { PushError, PushService, watchSessions } from './push.ts';
import { TerminalError, TerminalManager } from './terminal.ts';
import type { SocketData } from './terminal.ts';

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

// ── omo version check and update ──
let versionCache: { current: string; latest: string; updateAvailable: boolean; checkedAt: number } | null = null;
const VERSION_CACHE_MS = 10 * 60 * 1000; // 10 minutes

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

async function omoVersion() {
  if (versionCache && Date.now() - versionCache.checkedAt < VERSION_CACHE_MS) return versionCache;
  const proc = Bun.spawn(['omo', '--version'], { stdout: 'pipe', stderr: 'pipe' });
  const current = (await new Response(proc.stdout).text()).match(/omo (\d+\.\d+\.\d+)/)?.[1] || '';
  await proc.exited;
  let latest = '';
  try {
    const res = await fetch('https://registry.npmjs.org/omo-ai/latest', { signal: AbortSignal.timeout(5000) });
    if (res.ok) latest = (await res.json()).version || '';
  } catch {}
  const updateAvailable = !!(current && latest && latest !== current && semverGt(latest, current));
  versionCache = { current, latest, updateAvailable, checkedAt: Date.now() };
  return versionCache;
}

async function omoUpdate() {
  const run = async (cmd: string[], env: Record<string, string> = {}) => {
    const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    const out = await new Response(p.stdout).text();
    const err = await new Response(p.stderr).text();
    const code = await p.exited;
    if (code !== 0) throw new Error((err || out).trim() || `exit ${code}`);
    return (out + '\n' + err).trim();
  };
  const update = await run(['omo', 'update']);
  piAi = null; // omo binary changed; drop cached module
  versionCache = null;
  // Under bun (this server) senpi's daemon launcher falls back to a hardcoded /opt/homebrew/bin/node and fails with
  // "failed to spawn daemon process"; OMO_RUNTIME=node makes it use the node on PATH.
  try { return { update, restart: await run(['omo', 'app-server', 'daemon', 'restart'], { OMO_RUNTIME: 'node' }) }; }
  catch (e: any) { return { update, restartError: String(e?.message || e) }; }
}

// ── plan usage of the Claude and ChatGPT subscriptions omo signs in with ──
// app-server's account/rateLimits/read always fails (it serves only a Codex login) and omo keeps no rate-limit headers,
// so usage comes from the endpoints behind Claude Code's /usage and Codex's /status, called with omo's own tokens from
// auth.json. Neither is a public API. Tokens are never refreshed here: a refresh rotates the refresh token and would
// leave omo's copy dead, so an expired token shows as an error until omo refreshes it on its next request.
// Dashboards polling at once share one upstream call per USAGE_CACHE_MS.
type UsageWindow = { label: string; percent: number; resetsAt: number | null };
type UsageAccount = { provider: 'claude' | 'chatgpt'; name: string; plan: string | null; windows: UsageWindow[]; error?: string; expired?: boolean };
const USAGE_CACHE_MS = 30 * 1000;
class UsageExpired extends Error { constructor() { super('토큰이 만료됐습니다. omo가 다음 요청 때 갱신합니다'); } }
let usageCache: { at: number; data: Promise<{ checkedAt: number; accounts: UsageAccount[] }> } | null = null;

async function usageGet(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers: { ...headers, 'user-agent': 'omonitor/0.1.0', accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (res.status === 401) throw new UsageExpired();
  if (!res.ok) throw new Error(`사용량을 읽지 못했습니다 (HTTP ${res.status})`);
  return res.json();
}
const usagePct = (n: unknown) => Math.max(0, Math.min(100, Number(n) || 0));
const usageAt = (s: unknown) => (typeof s === 'string' && Date.parse(s)) || null;
// Claude reports limits[] (5-hour session, weekly, weekly per model); older replies have only the named windows.
function claudeWindows(u: any): UsageWindow[] {
  if (Array.isArray(u?.limits) && u.limits.length) {
    return u.limits.map((l: any) => ({
      label: l.kind === 'session' ? '5시간' : l.kind === 'weekly_all' ? '주간' : l.scope?.model?.display_name ? `주간 ${l.scope.model.display_name}` : String(l.kind),
      percent: usagePct(l.percent), resetsAt: usageAt(l.resets_at),
    }));
  }
  return ([['five_hour', '5시간'], ['seven_day', '주간'], ['seven_day_opus', '주간 Opus'], ['seven_day_sonnet', '주간 Sonnet']] as const)
    .filter(([k]) => u?.[k]).map(([k, label]) => ({ label, percent: usagePct(u[k].utilization), resetsAt: usageAt(u[k].resets_at) }));
}
const windowLabel = (sec: number) => (sec === 604800 ? '주간' : sec % 86400 === 0 ? `${sec / 86400}일` : sec % 3600 === 0 ? `${sec / 3600}시간` : `${Math.round(sec / 60)}분`);
function chatgptWindows(u: any): UsageWindow[] {
  return [u?.rate_limit?.primary_window, u?.rate_limit?.secondary_window].filter(Boolean).map((w: any) => ({
    label: windowLabel(Number(w.limit_window_seconds) || 0), percent: usagePct(w.used_percent), resetsAt: w.reset_at ? w.reset_at * 1000 : null,
  }));
}
async function usageOf(provider: UsageAccount['provider'], name: string, read: () => Promise<{ plan: string | null; windows: UsageWindow[] }>): Promise<UsageAccount> {
  try { return { provider, name, ...(await read()) }; }
  catch (e: any) { return { provider, name, plan: null, windows: [], error: String(e?.message || e), expired: e instanceof UsageExpired }; }
}
async function readUsage() {
  const auth = JSON.parse(await readFile(join(AGENT_DIR, 'auth.json'), 'utf8').catch(() => '{}'));
  const now = Date.now();
  const jobs: Promise<UsageAccount>[] = [];
  // anthropic-subscription keeps one slot per login in accounts[]; its top-level token is a placeholder.
  const claude = auth[SUBSCRIPTION] ?? auth['claude-sdk-oauth'];
  const slots = (Array.isArray(claude?.accounts) ? claude.accounts : claude ? [claude] : []).filter((a: any) => a?.access && a.access !== 'claude-sdk-oauth-managed');
  for (const a of slots) {
    jobs.push(usageOf('claude', slots.length > 1 && a.name ? `Claude ${a.name}` : 'Claude', async () => {
      if (a.expires && a.expires <= now) throw new UsageExpired();
      return { plan: null, windows: claudeWindows(await usageGet('https://api.anthropic.com/api/oauth/usage', { authorization: `Bearer ${a.access}`, 'anthropic-beta': 'oauth-2025-04-20' })) };
    }));
  }
  const gpt = auth['chatgpt-subscription'] ?? auth['openai-codex'];
  if (gpt?.access) {
    jobs.push(usageOf('chatgpt', 'ChatGPT', async () => {
      if (gpt.expires && gpt.expires <= now) throw new UsageExpired();
      const u = await usageGet('https://chatgpt.com/backend-api/wham/usage', { authorization: `Bearer ${gpt.access}`, ...(gpt.accountId ? { 'chatgpt-account-id': gpt.accountId } : {}) });
      return { plan: typeof u?.plan_type === 'string' ? u.plan_type : null, windows: chatgptWindows(u) };
    }));
  }
  return { checkedAt: now, accounts: await Promise.all(jobs) };
}
function planUsage() {
  if (!usageCache || Date.now() - usageCache.at >= USAGE_CACHE_MS) usageCache = { at: Date.now(), data: readUsage() };
  return usageCache.data;
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
  const task = {
    task_id: d.task_id, name: d.name, task_summary: d.task_summary, agent_type: d.subagent_type ?? d.agent_type, category: d.category,
    model: d.resolved_model?.display ?? d.model,
  };
  // A foreground task (run_in_background: false) or one that failed to start is already over when the task tool
  // returns, and no senpi-task.completion follows.
  if (d.status && !['running', 'queued', 'pending'].includes(d.status)) return { ...finishedTask(d), ...task };
  return { ...task, live_progress: { activity: '실행 중', started_at: Date.parse(at) || null } };
}
function finishedTask(d: any) {
  const ok = d.status === 'completed';
  return {
    task_id: d.task_id, name: d.name, agent_type: d.agent_type, category: d.category, model: d.resolved_model?.display ?? d.model, live_progress: null,
    final_response: ok ? String(d.final_response || '완료') : '', error_message: ok ? '' : String(d.error_message || d.error || d.reason || (d.status === 'cancelled' ? '취소됨' : d.status || '실패')),
    run_stats: { duration_ms: d.duration_ms ?? d.run_stats?.runtime_ms, tool_calls: d.run_stats?.tool_calls },
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

// ── git graph of a session folder: branch, upstream, uncommitted changes and the latest commits with their parents ──
const GIT_LOG_MAX = 200;
type GitRef = { name: string; kind: 'branch' | 'remote' | 'tag' | 'head'; current?: boolean };
async function git(cwd: string, args: string[]) {
  // Read-only: GIT_OPTIONAL_LOCKS=0 keeps `git status` off the index lock the agent's own git commands take, and a
  // repo's core.fsmonitor command is not run.
  const p = Bun.spawn(['git', '-c', 'core.fsmonitor=false', ...args], {
    cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err: err.trim(), code };
}
// `--decorate=full` names, e.g. "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1".
function gitRefs(decorations: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const d of decorations.split(', ').filter(Boolean)) {
    const current = d.startsWith('HEAD -> ');
    const ref = current ? d.slice(8) : d.replace(/^tag: /, '');
    if (ref === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (ref.startsWith('refs/heads/')) refs.push({ name: ref.slice(11), kind: 'branch', ...(current ? { current } : {}) });
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) refs.push({ name: ref.slice(13), kind: 'remote' });
    else if (ref.startsWith('refs/tags/')) refs.push({ name: ref.slice(10), kind: 'tag' });
  }
  return refs;
}
async function gitGraph(cwd: string) {
  if (!cwd) return { repo: false, reason: '작업 폴더가 없는 세션입니다' };
  if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) return { repo: false, reason: `작업 폴더를 찾지 못했습니다: ${cwd}` };
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { repo: false, reason: 'git 저장소가 아닌 폴더입니다' };
  const status = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  if (status.code !== 0) throw new Error(status.err || 'git status에 실패했습니다');
  const header = (key: string) => status.out.match(new RegExp(`^# branch\\.${key} (.+)$`, 'm'))?.[1];
  const initial = header('oid') === '(initial)';
  const ab = header('ab')?.match(/^\+(\d+) -(\d+)$/);
  // Branches, remote branches and tags, not the stash; a repo without commits has no HEAD to name.
  const log = await git(cwd, ['log', '--branches', '--remotes', '--tags', ...(initial ? [] : ['HEAD']), '--topo-order', `--max-count=${GIT_LOG_MAX + 1}`,
    '--decorate=full', '--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e']);
  if (log.code !== 0) throw new Error(log.err || 'git log에 실패했습니다');
  const commits = log.out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, refs, author, at, subject] = r.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], refs: gitRefs(refs), author, time: Number(at) * 1000, subject };
  });
  return {
    repo: true, root: top.out.trim(), branch: header('head') === '(detached)' ? null : header('head') || null, oid: initial ? null : header('oid') || null,
    upstream: header('upstream') || null, ahead: ab ? Number(ab[1]) : 0, behind: ab ? Number(ab[2]) : 0,
    changes: status.out.split('\n').filter((l) => /^[12u?] /.test(l)).length,
    commits: commits.slice(0, GIT_LOG_MAX), truncated: commits.length > GIT_LOG_MAX,
  };
}

// ── static files (only the assets used by the dashboard) ──
const STATIC = new Set([
  ENTRY, '/support.js', '/app/real-client.js', '/app/mock-client.js', '/app/store.js', '/app/styles.css',
  '/McSessionCard.dc.html', '/McRequestCard.dc.html', '/McItem.dc.html', '/McComposer.dc.html',
  '/manifest.webmanifest', '/app/icon-180.png', '/app/icon-512.png', '/app/icon-maskable-512.png',
  '/app/terminal.js', '/app/terminals.js', '/app/terminal-input.js', '/app/terminal-clipboard.js',
  '/app/terminal-reports.js', '/app/terminal-keys.js', '/app/terminal.css', '/app/push.js', '/sw.js', '/app/git-graph.js',
]);
const VENDOR = new Map([
  ['/vendor/xterm.js', join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.mjs')],
  ['/vendor/xterm.css', join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css')],
  ['/vendor/addon-fit.js', join(ROOT, 'node_modules/@xterm/addon-fit/lib/addon-fit.mjs')],
]);
async function serveStatic(pathname: string) {
  const vendor = VENDOR.get(pathname);
  if (vendor) return new Response(Bun.file(vendor), { headers: { 'cache-control': 'no-store', 'content-type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' } });
  if (!STATIC.has(decodeURIComponent(pathname))) return new Response('not found', { status: 404 });
  const p = join(ROOT, decodeURIComponent(pathname));
  try { const s = await stat(p); if (!s.isFile()) throw 0; } catch { return new Response('not found', { status: 404 }); }
  return new Response(Bun.file(p), { headers: { 'cache-control': 'no-store' } });
}

const terminals = new TerminalManager();
const push = new PushService(join(homedir(), '.omonitor/push.json'), 'https://github.com/jcwleo/omonitor');
const server = Bun.serve<SocketData>({
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
      return server.upgrade(req, { data: { kind: 'relay', queue: [] } }) ? undefined : new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/terminal-ws') {
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      if (!req.headers.get('origin')) return new Response('origin required', { status: 403 });
      try {
        const id = terminals.parseId(url.searchParams.get('id'));
        if (!terminals.has(id)) return new Response('터미널을 찾지 못했습니다', { status: 404 });
        return server.upgrade(req, { data: { kind: 'terminal', id, closed: false } }) ? undefined : new Response('upgrade failed', { status: 400 });
      } catch (error) {
        if (error instanceof TerminalError) return new Response(error.message, { status: error.status });
        throw error;
      }
    }
    const up = url.pathname.match(UPLOAD_PATH);
    if (up) {
      const f = Bun.file(join(UPLOADS, up[1]));
      return (await f.exists()) ? new Response(f, { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }) : new Response('not found', { status: 404 });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      if (url.pathname === '/api/terminal' || url.pathname.startsWith('/api/terminals/') || url.pathname === '/api/terminals') {
        try { return await terminals.http(req, url); }
        catch (error) {
          if (error instanceof TerminalError) return new Response(error.message, { status: error.status });
          if (error instanceof Error) { console.error('[terminal]', error); return new Response('터미널 처리에 실패했습니다', { status: 500 }); }
          throw error;
        }
      }
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
        if (url.pathname === '/api/push' && req.method === 'GET') return Response.json(await push.info());
        if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
          const body = await req.json().catch(() => null);
          if (url.pathname === '/api/push/subscribe') return Response.json(await push.subscribe(body));
          if (url.pathname === '/api/push/unsubscribe') return Response.json(await push.unsubscribe(body));
          if (url.pathname === '/api/push/test') return Response.json(await push.test(body));
          if (url.pathname === '/api/push/request') return Response.json(await push.relay(body));
        }
        if (url.pathname === '/api/usage' && req.method === 'GET') return Response.json(await planUsage());
        if (url.pathname === '/api/git' && req.method === 'GET') return Response.json(await gitGraph(url.searchParams.get('cwd') || ''));
        if (url.pathname === '/api/omo/version') return Response.json(await omoVersion());
        if (url.pathname === '/api/omo/update' && req.method === 'POST') return Response.json(await omoUpdate());
      } catch (e: any) { return new Response(String(e?.message || e), { status: e instanceof PushError ? e.status : 500 }); }
      return new Response('not found', { status: 404 });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    async open(ws) {
      if (ws.data.kind === 'terminal') { terminals.open(ws); return; }
      const relay = ws.data;
      let token = '';
      try { token = await readToken(); } catch { ws.close(1011, `토큰 파일을 읽지 못했습니다: ${TOKEN_FILE}`); return; }
      // Bun's client WebSocket can send headers and sends no Origin — both required by app-server.
      const up = new WebSocket(UPSTREAM, { headers: { Authorization: `Bearer ${token}` } } as any);
      ws.data.up = up;
      up.onopen = () => { for (const m of relay.queue.splice(0)) up.send(m); };
      up.onmessage = (e) => ws.send(String(e.data));
      up.onclose = (e) => ws.close(1011, `app-server 연결 종료 (${e.code})`);
      up.onerror = () => ws.close(1011, 'app-server에 연결하지 못했습니다');
    },
    message(ws, msg) {
      if (ws.data.kind === 'terminal') { terminals.message(ws, msg); return; }
      const up = ws.data.up;
      if (up && up.readyState === WebSocket.OPEN) up.send(String(msg));
      else ws.data.queue.push(String(msg));
    },
    close(ws) {
      if (ws.data.kind === 'terminal') { terminals.close(ws); return; }
      try { ws.data.up?.close(); } catch {}
    },
  },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void terminals.shutdown().then(() => {
      server.stop(true);
      process.exit(0);
    }).catch((error: unknown) => {
      if (!(error instanceof Error)) throw error;
      console.error('[terminal shutdown]', error);
      process.exit(1);
    });
  });
}
process.once('exit', () => { void terminals.shutdown(); });

if (!MOCK) watchSessions({ upstream: UPSTREAM, token: readToken, enabled: () => push.hasDevices(), notify: (m) => push.send(m) });

console.log(`omonitor → http://${HOST}:${PORT}  (${MOCK ? 'mock 시뮬레이터' : `app-server ${UPSTREAM}`})`);
