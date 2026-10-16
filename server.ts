// omonitor local backend — static files + the dashboard's session protocol bridged to `omo host`, bound to 127.0.0.1 only.
//   bun server.ts          # real mode: drives the shared omo host (~/.omo/agent/rpc/rpc.sock), starting it when needed
//   bun server.ts --mock   # UI runs on the in-browser simulator (no omo host needed)
// Env: PORT (4800), OMO_HOST_SOCKET, OMONITOR_ORIGINS
import { mkdir, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { engineOf, ensureHost, HOST_SOCKET, HostBridge, probeHost } from './host.ts';
import { PushError, PushService, watchSessions } from './push.ts';
import { ArchiveStore, SessionIndex } from './sessions.ts';
import { TerminalError, TerminalManager } from './terminal.ts';
import type { SocketData } from './terminal.ts';
import { applySelf, checkSelf, isServiceProcess } from './update.ts';
import type { GitRepo, GitSummary, GitWorktree, OmonitorUpdateResult, OmonitorVersion, OmoVersion, ThreadGit } from './src/protocol.ts';

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT || 4800);
const HOST = '127.0.0.1';
const AGENT_DIR = join(homedir(), '.omo/agent');
const SESSIONS_DIR = join(AGENT_DIR, 'sessions');
const ROOT = import.meta.dir;
const ENTRY = '/Mission Control.dc.html';
const KEY = crypto.randomUUID();
// OMONITOR_ORIGINS: extra allowed origins (comma-separated), e.g. a reverse-proxy/tunnel hostname in front of this port.
const EXTRA_ORIGINS = (process.env.OMONITOR_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`, ...EXTRA_ORIGINS]);

const originOk = (req: Request) => { const o = req.headers.get('origin'); return !o || ORIGINS.has(o); };
const keyOk = (req: Request, url: URL) => (url.searchParams.get('key') || req.headers.get('x-mc-key')) === KEY;
// WebSocket close reasons are limited to 123 bytes, and Korean text takes three bytes a character.
const wsReason = (s: string) => {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= 123) return s;
  let t = s;
  while (enc.encode(t).length > 120) t = t.slice(0, -1);
  return `${t}…`;
};

// ── saved sessions, read from their files without loading them into the omo host ──
const sessions = new SessionIndex(SESSIONS_DIR);
const threadPath = (threadId: string) => sessions.pathOf(threadId);

// ── Claude subscription models, for a model list that leaves them out ──
// app-server's model/list never saw providers registered by builtin extensions, such as anthropic-subscription (Claude
// subscription login). The omo host's get_available_models lists them, and the dashboard drops repeated ids, so this
// stays a fallback. They are rebuilt the way the extension builds them: the pi-ai anthropic catalog with the minimal
// level removed, taken from the pi-ai copy inside the installed omo.
const SUBSCRIPTION = 'anthropic-subscription';
// The installed omo-ai entry script (bin/omo.js), also when PATH's omo is omo-ai's bun launcher shim.
async function omoEntry() {
  const bin = Bun.which('omo');
  if (!bin) throw new Error('PATH에서 omo를 찾지 못했습니다');
  const entry = await realpath(bin);
  const shim = (await readFile(entry, 'utf8')).match(/^# entry: (.+)$/m); // omo-ai's bun launcher shim
  return shim ? shim[1].trim() : entry;
}
// The pi-ai catalog is read in a child bun process: a module imported here stays cached for this process's lifetime
// even after an omo update rewrites its files, so the new models would show only after omonitor restarts. Read again
// whenever the installed pi-ai file changes.
type PiCatalog = { contextWindows: Record<string, Record<string, number>>; subscription: { id: string; name: string; levels: string[] }[] };
const CATALOG_SCRIPT = `
const core = await import(process.env.PI_CORE), compat = await import(process.env.PI_COMPAT);
const contextWindows = {};
for (const p of compat.getProviders()) { try { contextWindows[p] = Object.fromEntries(compat.getModels(p).map((m) => [m.id, m.contextWindow || 0])); } catch {} }
const subscription = compat.getModels('anthropic').map((m) => {
  const model = { ...m, provider: '${SUBSCRIPTION}', thinkingLevelMap: { ...m.thinkingLevelMap, minimal: null } };
  return { id: m.id, name: m.name ?? m.id, levels: m.reasoning ? core.getSupportedThinkingLevels(model).filter((l) => l !== 'off') : [] };
});
console.log(JSON.stringify({ contextWindows, subscription }));
`;
let catalog: { key: string; data: Promise<PiCatalog> } | null = null;
async function piCatalog(): Promise<PiCatalog> {
  const from = dirname(Bun.resolveSync('@code-yeongyu/senpi', dirname(await omoEntry())));
  const core = Bun.resolveSync('@earendil-works/pi-ai', from), compat = Bun.resolveSync('@earendil-works/pi-ai/compat', from);
  const key = `${core}@${(await stat(core)).mtimeMs}`;
  if (catalog?.key !== key) {
    const data = exec([process.execPath, '-e', CATALOG_SCRIPT], { PI_CORE: core, PI_COMPAT: compat }).then((out) => JSON.parse(out) as PiCatalog);
    catalog = { key, data };
    data.catch(() => { if (catalog?.data === data) catalog = null; });
  }
  return catalog.data;
}
async function extraModels() {
  const auth = JSON.parse(await readFile(join(AGENT_DIR, 'auth.json'), 'utf8').catch(() => '{}'));
  if (!auth[SUBSCRIPTION] && !auth['claude-sdk-oauth']) return []; // claude-sdk-oauth: the provider's earlier auth key
  return (await piCatalog()).subscription.map((m) => ({
    id: `${SUBSCRIPTION}/${m.id}`, model: m.id, displayName: m.name, hidden: false,
    supportedReasoningEfforts: m.levels.map((reasoningEffort) => ({ reasoningEffort, description: '' })), defaultReasoningEffort: 'medium', isDefault: false,
  }));
}

// ── omo version check and update ──
let versionCache: OmoVersion | null = null;
const VERSION_CACHE_MS = 10 * 60 * 1000; // 10 minutes

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

// The engine of the host now serving the socket ("2026.10.16"; a build suffix after + is dropped).
const hostEngine = async () => engineOf((await probeHost(HOST_SOCKET)).engineVersion) || null;
const installedEngine = async () => (await exec(['omo', '--version'])).match(/engine: senpi ([^\s)]+)/)?.[1] || '';

async function omoVersion() {
  if (versionCache && Date.now() - versionCache.checkedAt < VERSION_CACHE_MS) return versionCache;
  const text = await exec(['omo', '--version']);
  const current = text.match(/omo (\d+\.\d+\.\d+)/)?.[1] || '';
  const engine = text.match(/engine: senpi ([^\s)]+)/)?.[1] || '';
  // A host started before an omo update keeps the old engine, model list included, until it hands over to the new one.
  const running = await hostEngine().catch(() => null);
  const stale = !!(engine && running && running !== engine);
  let latest = '';
  try {
    const res = await fetch('https://registry.npmjs.org/omo-ai/latest', { signal: AbortSignal.timeout(5000) });
    if (res.ok) latest = (await res.json()).version || '';
  } catch {}
  const updateAvailable = !!(current && latest && latest !== current && semverGt(latest, current));
  versionCache = { current, latest, updateAvailable, engine, running, stale, checkedAt: Date.now() };
  return versionCache;
}

async function exec(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim() || `exit ${code}`);
  return (out + '\n' + err).trim();
}

// `omo host ensure` hands the socket from a host of an older engine to the installed one: sessions mid-turn finish on the
// old generation and park, then reopen on the new one, so no turn is cut short. The restart counts once the host serving
// the socket answers with the installed engine.
async function restartHost() {
  const r = await ensureHost(HOST_SOCKET);
  const want = await installedEngine();
  let running: string | null = null;
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(500)) {
    running = await hostEngine().catch(() => null);
    if (running && (!want || running === want)) return `omo host ${running}${r.action === 'handoff' ? ' (새 엔진으로 넘김)' : r.action === 'start' ? ' (새로 시작)' : ''}`;
  }
  throw new Error(running ? `omo host가 아직 이전 엔진(${running})으로 실행 중입니다. 설치된 omo는 ${want}입니다` : 'omo host가 30초 안에 응답하지 않았습니다');
}

async function omoRestart() {
  try { return { restart: await restartHost() }; }
  finally { versionCache = null; }
}

async function omoUpdate() {
  const update = await exec(['omo', 'update']);
  versionCache = null;
  paletteCache = null;
  try { return { update, restart: await restartHost() }; }
  catch (e: any) { return { update, restartError: String(e?.message || e) }; }
  finally { versionCache = null; }
}

// ── omonitor's own update (update.ts) ──
// The check runs git fetch, so every open dashboard shares one cached result and one in-flight check or update.
let selfCache: { at: number; v: Promise<OmonitorVersion | null> } | null = null;
let selfUpdating: Promise<OmonitorUpdateResult> | null = null;
function omonitorVersion() {
  if (!selfCache || Date.now() - selfCache.at > VERSION_CACHE_MS) {
    const v = checkSelf(ROOT);
    selfCache = { at: Date.now(), v };
    v.catch(() => { if (selfCache?.v === v) selfCache = null; });
  }
  return selfCache.v;
}
async function updateOmonitor(): Promise<OmonitorUpdateResult> {
  try {
    const r = await applySelf(ROOT);
    const restarting = r.restartNeeded && isServiceProcess();
    // An error exit after the response is out: the service manager starts the pulled server code (update.ts).
    if (restarting) setTimeout(() => void terminals.shutdown().finally(() => process.exit(75)), 300);
    return { ...r, restarting };
  } finally { selfCache = null; }
}
const omonitorUpdate = () => (selfUpdating ??= updateOmonitor().finally(() => { selfUpdating = null; }));

// ── plan usage of the Claude and ChatGPT subscriptions omo signs in with ──
// app-server's account/rateLimits/read always fails (it serves only a Codex login) and omo keeps no rate-limit headers,
// so usage comes from the endpoints behind Claude Code's /usage and Codex's /status, called with omo's own tokens from
// auth.json. Neither is a public API. Tokens are never refreshed here: a refresh rotates the refresh token and would
// leave omo's copy dead, so an expired token shows as an error until omo refreshes it on its next request.
// Dashboards polling at once share one upstream call per provider per USAGE_CACHE_MS.
type UsageWindow = { label: string; percent: number; resetsAt: number | null };
type UsageAccount = { provider: 'claude' | 'chatgpt'; name: string; plan: string | null; windows: UsageWindow[]; error?: string; expired?: boolean };
// Anthropic's endpoint answers 429 to calls about 30s apart (anthropics/claude-code#31637), so Claude is read at most
// every 3 minutes, and a failed read waits as long as a good one.
const USAGE_CACHE_MS: Record<UsageAccount['provider'], number> = { claude: 3 * 60 * 1000, chatgpt: 30 * 1000 };
class UsageExpired extends Error { constructor() { super('토큰이 만료됐습니다. omo가 다음 요청 때 갱신합니다'); } }
const usageCache = new Map<UsageAccount['provider'], { at: number; data: Promise<UsageAccount[]> }>();

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
const readAuth = async () => JSON.parse(await readFile(join(AGENT_DIR, 'auth.json'), 'utf8').catch(() => '{}'));
async function claudeUsage() {
  const auth = await readAuth();
  const now = Date.now();
  // anthropic-subscription keeps one slot per login in accounts[]; its top-level token is a placeholder.
  const claude = auth[SUBSCRIPTION] ?? auth['claude-sdk-oauth'];
  const slots = (Array.isArray(claude?.accounts) ? claude.accounts : claude ? [claude] : []).filter((a: any) => a?.access && a.access !== 'claude-sdk-oauth-managed');
  return Promise.all(slots.map((a: any) => usageOf('claude', slots.length > 1 && a.name ? `Claude ${a.name}` : 'Claude', async () => {
    if (a.expires && a.expires <= now) throw new UsageExpired();
    return { plan: null, windows: claudeWindows(await usageGet('https://api.anthropic.com/api/oauth/usage', { authorization: `Bearer ${a.access}`, 'anthropic-beta': 'oauth-2025-04-20' })) };
  })));
}
async function chatgptUsage() {
  const auth = await readAuth();
  const now = Date.now();
  const gpt = auth['chatgpt-subscription'] ?? auth['openai-codex'];
  if (!gpt?.access) return [];
  return [await usageOf('chatgpt', 'ChatGPT', async () => {
    if (gpt.expires && gpt.expires <= now) throw new UsageExpired();
    const u = await usageGet('https://chatgpt.com/backend-api/wham/usage', { authorization: `Bearer ${gpt.access}`, ...(gpt.accountId ? { 'chatgpt-account-id': gpt.accountId } : {}) });
    return { plan: typeof u?.plan_type === 'string' ? u.plan_type : null, windows: chatgptWindows(u) };
  })];
}
function cachedUsage(provider: UsageAccount['provider'], read: () => Promise<UsageAccount[]>) {
  const hit = usageCache.get(provider);
  if (hit && Date.now() - hit.at < USAGE_CACHE_MS[provider]) return hit.data;
  const data = read();
  usageCache.set(provider, { at: Date.now(), data });
  return data;
}
async function planUsage() {
  const [claude, chatgpt] = await Promise.all([cachedUsage('claude', claudeUsage), cachedUsage('chatgpt', chatgptUsage)]);
  return { checkedAt: Date.now(), accounts: [...claude, ...chatgpt] };
}

// ── slash palette: the commands and skills omo runs for `/name` and `/skill:name` ──
// A turn starting with a `/name` omo has not registered is refused as an unknown command, so the palette lists what the
// installed omo registers. `get_commands` of a short-lived
// `omo --mode rpc --no-session` returns every registered command and loaded skill (about 1.5s, no session file). It is
// asked again when the installed omo version changes and at most every 10 minutes, so an update or a newly added skill
// shows up without touching this file.
const PALETTE_TTL_MS = 10 * 60 * 1000;
// The dashboard does not show a command's terminal notices (ctx.ui.notify) and the omo host refuses custom UI, so a command
// that only prints a notice, or opens a picker, editor, overlay or another app, does nothing when sent from the dashboard.
const TERMINAL_ONLY = new Set([
  'answer', 'btw', 'diff', 'history', 'ir', 'keybindings', 'llama', 'task-kill',
  'account', 'claude-account', 'cursor-account', 'gpt-account', 'dag', 'doctor', 'facts', 'fallback', 'files', 'help', 'hooks',
  'lookat', 'mcp', 'memfs', 'memory', 'nested-agents', 'palace', 'people', 'rules', 'search', 'sleeptime', 'tasks', 'ttsr', 'tui', 'websearch',
]);
// Short Korean blurbs; any other command or skill shows omo's own description.
const COMMAND_KO: Record<string, string> = {
  goal: '세션 목표 설정·조회·일시정지·해제', loop: '프롬프트를 일정 간격으로 반복 (예: /loop 5m 배포 확인)', todo: 'todo 항목 추가·시작·완료·포기·삭제',
  fast: '현재 모델의 ChatGPT 구독 fast 모드 켜기·끄기', reasoning: '현재 모델의 reasoning 켜기·끄기', efforts: '현재 모델의 reasoning effort 설정',
  'reload-rules': '이 세션의 pi-rules 다시 읽기', computer: '컴퓨터 사용(실험) 켜기·끄기', remember: '내용을 장기 메모리에 저장',
  init: '메모리 저장소 초기화 후 초기 메모리 작성', recompile: '다음 실행 때 메모리를 시스템 프롬프트에 다시 반영',
  'memory-repository': '메모리 저장소의 push 전용 미러 원격 설정', reflect: '지금 메모리 reflection 실행 요청', dream: '여러 대화를 묶는 메모리 dream 실행 요청',
};
const KEYWORDS = [
  { kind: 'keyword', name: 'ulw', insert: 'ulw ', label: 'ultrawork · ulw', desc: '어려운 작업: 코드 파악 → 계획 → 단계별 검증', source: 'builtin' },
  { kind: 'keyword', name: 'mass ulw', insert: 'mass ulw ', label: 'mass ulw', desc: '작업을 에이전트 그래프로 나눠 병렬 실행', source: 'builtin' },
];
function frontmatter(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (m) for (const line of m[1].split('\n')) { const kv = line.match(/^(\w[\w-]*):\s*(.*)$/); if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, ''); }
  return out;
}
// Short Korean blurbs for bundled skills; any other skill shows its SKILL.md description.
const SKILL_KO: Record<string, string> = {
  'git-master': '원자적 커밋 · 리베이스 · 이력 추적', 'review-work': '구현 후 실제 화면 QA + 게이트 리뷰', 'ulw-research': '출처 인용이 필요한 최대 포화 리서치',
  frontend: 'UI/UX 구현 · 스타일링', debugging: '재현 → 원인 추적 → 수정 검증', 'init-deep': '폴더별 AGENTS.md 계층 생성',
  'ulw-execute': 'Prometheus 계획으로 Atlas 실행 시작', refactor: 'LSP·AST-grep 기반 리팩터링 + TDD 검증', 'remove-ai-slops': '브랜치 변경에서 AI 티 나는 코드 정리',
  hyperplan: '팀 모드 적대적 계획 (team_mode 필요)',
};
// One command of a short-lived `omo --mode rpc --no-session`, under omo's default runtime like the omo host: some skills
// exist only under one runtime (bun-1-4 needs a Bun eval kernel), and one the host's sessions lack is refused there.
async function askOmo(type: string): Promise<any> {
  const p = Bun.spawn(['omo', '--mode', 'rpc', '--no-session', '--offline'], { cwd: import.meta.dir, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' });
  const timer = setTimeout(() => p.kill(), 20000);
  try {
    p.stdin.write(`${JSON.stringify({ id: 'ask', type })}\n`);
    p.stdin.flush();
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of p.stdout) {
      buf += dec.decode(chunk, { stream: true });
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
        let m: any;
        try { m = JSON.parse(buf.slice(0, i)); } catch { continue; }
        if (m.id !== 'ask') continue;
        if (!m.success) throw new Error(m.error || `${type} 실패`);
        return m.data;
      }
    }
    throw new Error(`omo가 ${type}에 답하지 않고 끝났습니다`);
  } finally { clearTimeout(timer); p.kill(); }
}
const askOmoCommands = async (): Promise<any[]> => (await askOmo('get_commands'))?.commands || [];
let paletteCache: { version: string; at: number; list: Promise<any[]> } | null = null;
async function omoCommands() {
  const entry = await omoEntry();
  const version = JSON.parse(await readFile(join(dirname(dirname(entry)), 'package.json'), 'utf8')).version || '';
  if (!paletteCache || paletteCache.version !== version || Date.now() - paletteCache.at > PALETTE_TTL_MS) {
    const list = askOmoCommands();
    paletteCache = { version, at: Date.now(), list };
    list.catch(() => { if (paletteCache?.list === list) paletteCache = null; });
  }
  return paletteCache.list;
}
// Used only when omo cannot be asked: the skills folders of the daemon's extensions and ~/.omo/agent/skills.
async function folderSkills() {
  let exts: string[] = [];
  try { exts = JSON.parse(await readFile(join(AGENT_DIR, 'app-server-daemon/settings.json'), 'utf8')).extensions || []; } catch {}
  const out: any[] = [];
  for (const [dir, scope] of [...exts.map((e) => [join(e, 'skills'), 'system']), [join(AGENT_DIR, 'skills'), 'user']]) {
    let names: string[] = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const n of names) {
      try { const fm = frontmatter(await readFile(join(dir, n, 'SKILL.md'), 'utf8')); out.push({ name: fm.name || n, description: fm.description || '', scope }); } catch {}
    }
  }
  return out;
}
async function listSkills() {
  let found: any[] = [];
  try { found = await omoCommands(); } catch (e: any) { console.warn('[omonitor] omo 명령 목록을 읽지 못했습니다:', e?.message || e); }
  // project-scope entries belong to the cwd the list was read in, not to every session.
  const usable = found.filter((c) => c.sourceInfo?.scope !== 'project');
  const commands = usable.filter((c) => c.source !== 'skill' && !TERMINAL_ONLY.has(c.name))
    .map((c) => ({ kind: 'command', name: c.name, desc: COMMAND_KO[c.name] || c.description || '', source: c.sourceInfo?.scope === 'user' ? 'user' : 'builtin' }));
  let skills = usable.filter((c) => c.source === 'skill').map((c) => ({ name: String(c.name).replace(/^skill:/, ''), description: c.description, scope: c.sourceInfo?.scope }));
  if (!skills.length) skills = await folderSkills();
  const items = new Map<string, any>();
  for (const s of skills) if (!items.has(s.name)) items.set(s.name, { kind: 'skill', name: s.name, label: `/skill:${s.name}`, insert: `/skill:${s.name} `, desc: SKILL_KO[s.name] || s.description || '', source: s.scope === 'system' ? 'builtin' : 'user' });
  const order = (a: any, b: any) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'builtin' ? -1 : 1);
  return [...commands.sort(order), ...[...items.values()].sort(order), ...KEYWORDS];
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

// Last conversation time per session. A file's last entry also moves when a session is merely loaded (omo appends
// metadata such as a pi-rules.scan entry), so only message and compaction entries count (SessionIndex.talkedAt).
async function activityTimes() {
  const times: Record<string, number> = {};
  for (const m of await sessions.list()) if (m.talkedAt) times[m.id] = m.talkedAt;
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
    const { contextWindows } = await piCatalog();
    const find = (p: string) => contextWindows[p]?.[model];
    return find(provider) || find(provider.replace(/-subscription$/, '')) || Object.keys(contextWindows).map(find).find(Boolean) || null;
  } catch { return null; }
}
async function threadMeta(threadId: string) {
  const path = await threadPath(threadId);
  if (!path) return { agents: [], usage: null, skills: {} };
  const agents = new Map<string, any>();
  // Skills loaded inside another tool (eval's tool.read of a SKILL.md), by that tool's call id. The app-server's item
  // carries only the tool's text output; the session file keeps the nested calls in the result details.
  const skills: Record<string, string[]> = {};
  let last: any = null;
  for (const line of (await readSession(path)).split('\n')) {
    if (!line.includes('"usage"') && !line.includes('"toolName":"task"') && !line.includes('senpi-task.completion') && !line.includes('"type":"compaction"') && !line.includes('SKILL.md')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type === 'compaction') last = null; // the next response reports the compacted context
    else if (m?.role === 'assistant' && m.usage) last = m;
    else if (m?.role === 'toolResult' && m.toolName === 'task' && m.details) {
      for (const d of m.details.items || [m.details]) if (d?.task_id) agents.set(d.task_id, { ...agents.get(d.task_id), ...spawnedTask(d, e.timestamp) });
    } else if (m?.role === 'toolResult' && Array.isArray(m.details?.toolCalls)) {
      const names = m.details.toolCalls.filter((c: any) => /^read$/i.test(c?.name || '') && c.ok !== false).map((c: any) => String(c.args?.path || c.args?.file_path || '')).filter((p: string) => /(^|\/)SKILL\.md$/.test(p)).map((p: string) => p.split('/').at(-2)).filter(Boolean);
      if (names.length) skills[m.toolCallId] = [...new Set<string>(names)];
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
  return { agents: [...agents.values()], usage, skills };
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
// `git status --porcelain=v2 --branch`: the branch (null on a detached HEAD), upstream, ahead/behind and changed files.
function statusFacts(out: string) {
  const header = (key: string) => out.match(new RegExp(`^# branch\\.${key} (.+)$`, 'm'))?.[1];
  const oid = header('oid');
  const ab = header('ab')?.match(/^\+(\d+) -(\d+)$/);
  return {
    branch: header('head') === '(detached)' ? null : header('head') || null, initial: oid === '(initial)', oid: oid && oid !== '(initial)' ? oid : null,
    upstream: header('upstream') || null, ahead: ab ? Number(ab[1]) : 0, behind: ab ? Number(ab[2]) : 0,
    changes: out.split('\n').filter((l) => /^[12u?] /.test(l)).length,
  };
}
async function gitGraph(cwd: string) {
  if (!cwd) return { repo: false, reason: '작업 폴더가 없는 세션입니다' };
  if (!(await stat(cwd).then((s) => s.isDirectory(), () => false))) return { repo: false, reason: `작업 폴더를 찾지 못했습니다: ${cwd}` };
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { repo: false, reason: 'git 저장소가 아닌 폴더입니다' };
  const status = await git(cwd, ['status', '--porcelain=v2', '--branch']);
  if (status.code !== 0) throw new Error(status.err || 'git status에 실패했습니다');
  const st = statusFacts(status.out);
  const initial = st.initial;
  // Branches, remote branches and tags, not the stash; a repo without commits has no HEAD to name.
  const log = await git(cwd, ['log', '--branches', '--remotes', '--tags', ...(initial ? [] : ['HEAD']), '--topo-order', `--max-count=${GIT_LOG_MAX + 1}`,
    '--decorate=full', '--format=%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e']);
  if (log.code !== 0) throw new Error(log.err || 'git log에 실패했습니다');
  const commits = log.out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [hash, parents, refs, author, at, subject] = r.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], refs: gitRefs(refs), author, time: Number(at) * 1000, subject };
  });
  const repo = await cwdRepo(cwd);
  return {
    repo: true, root: top.out.trim(), branch: st.branch, oid: st.oid, upstream: st.upstream, ahead: st.ahead, behind: st.behind, changes: st.changes,
    commits: commits.slice(0, GIT_LOG_MAX), truncated: commits.length > GIT_LOG_MAX,
    worktrees: repo ? await repoWorktrees(repo.common, repo.top).catch(() => []) : [],
  };
}

// ── branch and worktree of every session (board cards, session list, session header) ──
// A session's cwd stays where it started, while an agent that follows a worktree workflow works in another folder of the
// same repo (<repo>/.worktree/<task>). So the worktree a session works in is read from its session file: the last tool
// call that names a worktree of the repo, or one the session added itself with `git worktree add`.
const HOME = homedir();
// A summary covers every session folder and each worktree of their repos, so at most 8 git processes run at once.
let gitSlots = 8;
const gitQueue: (() => void)[] = [];
async function gitLimited(cwd: string, args: string[]) {
  if (gitSlots > 0) gitSlots--; else await new Promise<void>((r) => gitQueue.push(r));
  try { return await git(cwd, args); } finally { const next = gitQueue.shift(); if (next) next(); else gitSlots++; }
}
// A folder's repo: its worktree's top folder and the common git dir all worktrees share. atTop: the folder is that top
// (perhaps through a symlink), so paths relative to it are relative to the worktree. Cached for a minute.
type CwdRepo = { top: string; common: string; atTop: boolean };
const cwdRepos = new Map<string, { at: number; v: Promise<CwdRepo | null> }>();
function cwdRepo(cwd: string) {
  const hit = cwdRepos.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = (async () => {
    const real = await realpath(cwd).catch(() => null);
    if (!real || !(await stat(real).then((s) => s.isDirectory(), () => false))) return null;
    const r = await gitLimited(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const [top, common] = r.out.trim().split('\n');
    return r.code === 0 && top && common ? { top, common, atTop: real === top } : null;
  })();
  cwdRepos.set(cwd, { at: Date.now(), v });
  return v;
}
// Every worktree of a repo (the main one first) with its branch, upstream and uncommitted changes. Cached for 8 seconds.
const repoTrees = new Map<string, { at: number; v: Promise<GitWorktree[]> }>();
function repoWorktrees(common: string, anyCwd: string) {
  const hit = repoTrees.get(common);
  if (hit && Date.now() - hit.at < 8_000) return hit.v;
  const v = (async () => {
    const list = await gitLimited(anyCwd, ['worktree', 'list', '--porcelain']);
    if (list.code !== 0) throw new Error(list.err || 'git worktree list에 실패했습니다');
    // Blocks of `key value` lines; `bare`, `detached`, `locked` and `prunable` may stand alone.
    const trees = list.out.trim().split('\n\n').map((block, i) => {
      const kv = new Map(block.split('\n').map((l) => { const sp = l.indexOf(' '); return sp < 0 ? [l, ''] : [l.slice(0, sp), l.slice(sp + 1)]; }));
      return { path: kv.get('worktree') || '', head: kv.get('HEAD') || null, branch: kv.get('branch')?.replace(/^refs\/heads\//, '') || null, main: i === 0,
        bare: kv.has('bare'), locked: kv.has('locked'), missing: kv.has('prunable') };
    }).filter((w) => w.path && !w.bare);
    return Promise.all(trees.map(async ({ bare, ...w }): Promise<GitWorktree> => {
      const base = { ...w, upstream: null, ahead: 0, behind: 0, changes: 0 };
      if (w.missing) return base;
      const st = await gitLimited(w.path, ['status', '--porcelain=v2', '--branch']).catch(() => null);
      if (!st || st.code !== 0) return { ...base, missing: !(await stat(w.path).then((s) => s.isDirectory(), () => false)) };
      const f = statusFacts(st.out);
      return { ...base, upstream: f.upstream, ahead: f.ahead, behind: f.behind, changes: f.changes };
    }));
  })();
  repoTrees.set(common, { at: Date.now(), v });
  v.catch(() => repoTrees.delete(common));
  return v;
}
// Only session files under omo's sessions folder are read; the client names them.
function sessionFile(path: unknown) {
  if (typeof path !== 'string' || !path) return null;
  const f = resolve(path.replace(/^~(?=\/)/, HOME));
  return f.startsWith(`${SESSIONS_DIR}/`) && f.endsWith('.jsonl') ? f : null;
}
const stringsOf = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (typeof v === 'string') out.push(v);
  else if (v && typeof v === 'object' && depth < 6) for (const x of Object.values(v)) stringsOf(x, out, depth + 1);
  return out;
};
const unquote = (t: string) => t.replace(/^['"`(]+|['"`),;]+$/g, '');
const absPath = (p: string, base: string) => resolve(base, p.replace(/^~(?=\/|$)/, HOME)).replace(/(.)\/+$/, '$1');
// `git [-C dir] worktree add [options] <path> [<commit-ish>]` → [path, branch]. -b/-B name the new branch; without them
// git checks out <commit-ish>, or creates a branch named after the folder.
const WT_ADD = /git\s+(?:-C\s+(\S+)\s+)?worktree\s+add\s+([^\n;&|]*)/g;
function worktreeAdds(text: string, base: string): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (const m of text.matchAll(WT_ADD)) {
    const dir = m[1] ? absPath(unquote(m[1]), base) : base;
    const toks = m[2].split(/\s+/).map(unquote).filter(Boolean);
    let branch: string | null = null;
    const pos: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (/[<>]/.test(t)) break; // a redirection ends the command
      if (t === '-b' || t === '-B') branch = toks[++i] ?? null;
      else if (t === '--reason') i++;
      else if (!t.startsWith('-')) pos.push(t);
    }
    // Plain names only: a token with quotes, braces or $ belongs to the code around the command, or is a variable.
    const plain = (x?: string | null) => (x && /^[\w./~-]+$/.test(x) ? x : null);
    if (!plain(pos[0])) continue;
    const path = absPath(pos[0], dir);
    const guess = pos[1] ? (plain(pos[1]) && !/^(HEAD|[0-9a-f]{7,40})$|~/.test(pos[1]) ? pos[1] : null) : basename(path);
    out.push([path, branch != null ? plain(branch) : guess]);
  }
  return out;
}
// The worktree a text names last. An absolute, ~ or (from the worktree's top) relative path counts when it is a whole
// path or a prefix ending at a /: .worktree/a matches .worktree/a/x.ts but not .worktree/ab.
type PathForm = { s: string; path: string; rel: boolean };
function lastMention(text: string, forms: PathForm[]) {
  let best: { i: number; len: number; path: string } | null = null;
  for (const f of forms) {
    for (let i = text.lastIndexOf(f.s); i >= 0; i = i > 0 ? text.lastIndexOf(f.s, i - 1) : -1) {
      const before = i ? text[i - 1] : '', after = text[i + f.s.length] ?? '';
      if (after && /[\w.~-]/.test(after)) continue;
      if (f.rel ? before && (/[\w.~-]/.test(before) || (before === '/' && text.slice(i - 2, i) !== './')) : before && /[\w.~/-]/.test(before)) continue;
      if (!best || i > best.i || (i === best.i && f.s.length > best.len)) best = { i, len: f.s.length, path: f.path };
      break;
    }
  }
  return best;
}
// Session files only grow, so each is read once and then from where the last read ended. The state starts over when the
// repo's worktrees change, since the paths to look for change with them.
// mainAfter: the main checkout was named after `last`.
type SessionScan = { key: string; offset: number; added: Map<string, string | null>; last: string | null; mainAfter: boolean };
const scans = new Map<string, SessionScan>();
const scanLocks = new Map<string, Promise<unknown>>();
function scanSession(file: string, cwd: string, repo: CwdRepo, main: string, existing: string[]) {
  const run = async () => {
    const key = [cwd, repo.top, main, ...existing].join('\n');
    const size = (await stat(file)).size;
    let s = scans.get(file);
    if (!s || s.key !== key || size < s.offset) scans.set(file, (s = { key, offset: 0, added: new Map(), last: null, mainAfter: false }));
    if (size > s.offset) {
      const buf = new Uint8Array(await Bun.file(file).slice(s.offset, size).arrayBuffer());
      const end = buf.lastIndexOf(10) + 1; // complete lines only; the rest is read once it ends
      if (end) { s.offset += end; scanLines(s, new TextDecoder().decode(buf.subarray(0, end)), cwd, repo, main, existing); }
    }
    return s;
  };
  const p = (scanLocks.get(file) || Promise.resolve()).then(run);
  scanLocks.set(file, p.catch(() => {}));
  return p;
}
function scanLines(s: SessionScan, text: string, cwd: string, repo: CwdRepo, main: string, existing: string[]) {
  // A cwd that is a symlink to the top (macOS /tmp) also names paths through itself.
  const alias = repo.atTop && cwd !== repo.top ? cwd : null;
  const toTop = (p: string) => (alias && p.startsWith(`${alias}/`) ? repo.top + p.slice(alias.length) : p);
  const formsOf = () => [...new Set([...existing, ...s.added.keys()])].flatMap((p) => {
    const out: PathForm[] = [{ s: p, path: p, rel: false }];
    if (p.startsWith(`${HOME}/`)) out.push({ s: `~${p.slice(HOME.length)}`, path: p, rel: false });
    if (p.startsWith(`${repo.top}/`)) {
      const rest = p.slice(repo.top.length + 1);
      if (alias) out.push({ s: `${alias}/${rest}`, path: p, rel: false });
      if (repo.atTop) out.push({ s: rest, path: p, rel: true });
    }
    return out;
  });
  // The main checkout counts only by an absolute (or ~) path: a relative one is relative to the session's own folder.
  const mainForms: PathForm[] = [{ s: main, path: main, rel: false }];
  if (main.startsWith(`${HOME}/`)) mainForms.push({ s: `~${main.slice(HOME.length)}`, path: main, rel: false });
  if (alias && main === repo.top) mainForms.push({ s: alias, path: main, rel: false });
  let forms = formsOf();
  for (const line of text.split('\n')) {
    if (!line.includes('"toolCall"') && !line.includes('"bashExecution"')) continue;
    if (!line.includes('worktree') && ![...forms, ...mainForms].some((f) => line.includes(f.s))) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const m = e?.message;
    // What the agent ran (tool call arguments) and the user's own ! commands; tool output would name every worktree.
    const texts: string[] = m?.role === 'assistant' ? (m.content || []).filter((b: any) => b?.type === 'toolCall').map((b: any) => stringsOf(b.arguments).join('\n'))
      : m?.role === 'bashExecution' ? [String(m.command || '')] : [];
    for (const t of texts) {
      const adds = worktreeAdds(t, repo.atTop ? repo.top : cwd);
      for (const [p, branch] of adds) s.added.set(toTop(p), branch);
      if (adds.length) forms = formsOf();
      // A call that names a worktree works there, even when it names the main checkout later on (reading a file there).
      const wt = lastMention(t, forms), m = lastMention(t, mainForms);
      if (wt) { s.last = wt.path; s.mainAfter = !!m && m.i > wt.i; }
      else if (m && s.last) s.mainAfter = true;
    }
  }
}
// Where a session works: the worktree its tool calls named last. While that worktree exists, a mention of the main
// checkout does not move the session back (agents read files there in passing); once it is gone, a later mention of the
// main checkout means the session went back to it. With neither, the session's own folder.
function placeOf(trees: GitWorktree[], own: GitWorktree, main: GitWorktree, scan: SessionScan | null) {
  const last = scan?.last && scan.last !== own.path ? scan.last : null;
  const hit = last ? trees.find((w) => w.path === last) : null;
  if (last && !hit && !scan!.mainAfter) return { worktree: last, branch: scan!.added.get(last) ?? null, head: null, removed: true, inferred: true };
  const w = hit || (last ? main : own);
  return { worktree: w.path, branch: w.branch, head: w.head, removed: w.missing, inferred: !!hit };
}
async function gitSummary(threads: { id: string; cwd: string; path?: unknown }[]): Promise<GitSummary> {
  const repos: Record<string, GitRepo> = {};
  const out: Record<string, ThreadGit> = {};
  await Promise.all(threads.map(async (t) => {
    try {
      const repo = await cwdRepo(t.cwd);
      if (!repo) return;
      const trees = await repoWorktrees(repo.common, repo.top);
      const main = trees.find((w) => w.main);
      if (!main) return;
      repos[repo.common] ??= { root: main.path, name: basename(main.path), worktrees: trees };
      const own = trees.find((w) => w.path === repo.top) || main;
      const file = sessionFile(t.path);
      const scan = file ? await scanSession(file, t.cwd, repo, main.path, trees.filter((w) => !w.main).map((w) => w.path)).catch(() => null) : null;
      out[t.id] = { repo: repo.common, ...placeOf(trees, own, main, scan) };
    } catch (e: any) { console.warn(`[git] ${t.cwd}: ${e?.message || e}`); }
  }));
  return { checkedAt: Date.now(), repos, threads: out };
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
const bridge = new HostBridge({
  socket: HOST_SOCKET, index: sessions, archive: new ArchiveStore(join(homedir(), '.omonitor/archived.json')), trashDir: join(homedir(), '.omonitor/trash'),
  fallbackModels: async () => (await askOmo('get_available_models'))?.models || [],
});
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
      return Response.json({ mode: MOCK ? 'mock' : 'real', key: KEY, upstream: HOST_SOCKET });
    }
    if (url.pathname === '/ws') {
      if (MOCK) return new Response('mock mode', { status: 404 });
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      return server.upgrade(req, { data: { kind: 'relay' } }) ? undefined : new Response('upgrade failed', { status: 400 });
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
        if (url.pathname === '/api/skills') return Response.json(await listSkills());
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
        if (url.pathname === '/api/git/summary' && req.method === 'POST') {
          const body = await req.json().catch(() => null);
          if (!Array.isArray(body?.threads)) return new Response('threads 배열이 필요합니다', { status: 400 });
          const threads = body.threads.slice(0, 2000).filter((t: any) => typeof t?.id === 'string' && typeof t.cwd === 'string' && t.cwd.startsWith('/'));
          return Response.json(await gitSummary(threads));
        }
        if (url.pathname === '/api/omo/version') return Response.json(await omoVersion());
        if (url.pathname === '/api/omo/update' && req.method === 'POST') return Response.json(await omoUpdate());
        if (url.pathname === '/api/omo/restart' && req.method === 'POST') return Response.json(await omoRestart());
        if (url.pathname === '/api/omonitor/version') return Response.json(await omonitorVersion());
        if (url.pathname === '/api/omonitor/update' && req.method === 'POST') return Response.json(await omonitorUpdate());
      } catch (e: any) { return new Response(String(e?.message || e), { status: e instanceof PushError ? e.status : 500 }); }
      return new Response('not found', { status: 404 });
    }
    return serveStatic(url.pathname);
  },
  websocket: {
    async open(ws) {
      if (ws.data.kind === 'terminal') { terminals.open(ws); return; }
      ws.data.client = bridge.addClient({
        send: (data) => { ws.send(data); },
        close: (code, reason) => { try { ws.close(code, wsReason(reason)); } catch {} },
      });
    },
    message(ws, msg) {
      if (ws.data.kind === 'terminal') { terminals.message(ws, msg); return; }
      if (ws.data.client) void bridge.message(ws.data.client, String(msg));
    },
    close(ws) {
      if (ws.data.kind === 'terminal') { terminals.close(ws); return; }
      if (ws.data.client) bridge.removeClient(ws.data.client);
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

if (!MOCK) {
  bridge.start();
  watchSessions({
    bridge, enabled: () => push.hasDevices(), notify: (m) => push.send(m), relay: (body) => push.relay(body),
    lastTurn: async (id) => { const path = await threadPath(id); return path ? (await parseHistory(path)).at(-1) || null : null; },
    nameOf: async (id) => { const m = (await sessions.list()).find((x) => x.id === id); return bridge.nameOf(id) || m?.name || m?.preview.slice(0, 40) || '이름 없는 세션'; },
  });
}

console.log(`omonitor → http://${HOST}:${PORT}  (${MOCK ? 'mock 시뮬레이터' : `omo host ${HOST_SOCKET}`})`);
