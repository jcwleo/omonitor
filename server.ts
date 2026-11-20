// omonitor local backend: serves the dashboard and bridges /ws to the shared OpenCode 2 server.
// bun server.ts --mock runs the in-browser simulator instead.
// Env: PORT (4800), OMONITOR_ORIGINS, OPENCODE_SERVICE_FILE
import { mkdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpencodeBridge, opencodeBin, opencodeInstalled, runningVersion } from './opencode.ts';
import { PushError, PushService, watchSessions } from './push.ts';
import { TerminalError, TerminalManager } from './terminal.ts';
import type { SocketData } from './terminal.ts';
import { applySelf, checkSelf, isServiceProcess } from './update.ts';
import { createPlanUsage } from './usage.ts';
import { UsageAuth } from './usage-auth.ts';
import { UsageAuthStore } from './usage-auth-store.ts';
import type { GitRepo, GitSummary, GitWorktree, OmonitorUpdateResult, OmonitorVersion, OpencodeVersion, OpenResult, ThreadGit } from './src/protocol.ts';

const MOCK = process.argv.includes('--mock');
const PORT = Number(process.env.PORT || 4800);
const HOST = '127.0.0.1';
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

const VERSION_CACHE_MS = 10 * 60 * 1000; // 10 minutes

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return true; if ((pa[i] || 0) < (pb[i] || 0)) return false; }
  return false;
}

async function exec(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error((err || out).trim() || `exit ${code}`);
  return (out + '\n' + err).trim();
}

// ── opencode2 version check and update ──
// current: the installed CLI; running: the shared service, which keeps the binary it started with until it restarts.
let opencodeCache: OpencodeVersion | null = null;
const cliVersion = async (bin: string) => (await exec([bin, '--version'])).match(/(\d+\.\d+\.\d+)/)?.[1] || '';
async function opencodeVersion(): Promise<OpencodeVersion | null> {
  if (opencodeCache && Date.now() - opencodeCache.checkedAt < VERSION_CACHE_MS) return opencodeCache;
  const bin = opencodeBin();
  if (!bin) return null;
  const [current, running] = await Promise.all([cliVersion(bin), runningVersion().catch(() => null)]);
  let latest = '';
  try {
    const res = await fetch('https://registry.npmjs.org/@opencode/cli/latest', { signal: AbortSignal.timeout(5000) });
    if (res.ok) latest = (await res.json()).version || '';
  } catch {}
  opencodeCache = { current, latest, running, updateAvailable: !!(current && latest && semverGt(latest, current)), stale: !!(current && running && running !== current), checkedAt: Date.now() };
  return opencodeCache;
}
// The service restarts on the installed binary; the restart counts once it answers with that version. The dashboard's
// opencode connection drops with it and reconnects (opencode.ts).
async function restartOpencode() {
  const bin = opencodeBin();
  if (!bin) throw new Error('opencode2를 찾지 못했습니다');
  await exec([bin, 'service', 'restart']);
  const want = await cliVersion(bin);
  let running: string | null = null;
  for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(500)) {
    running = await runningVersion().catch(() => null);
    if (running && (!want || running === want)) return `opencode ${running}`;
  }
  throw new Error(running ? `opencode 서버가 아직 이전 버전(${running})으로 실행 중입니다. 설치된 opencode는 ${want}입니다` : 'opencode 서버가 30초 안에 응답하지 않았습니다');
}
async function opencodeRestart() {
  try { return { restart: await restartOpencode() }; } finally { opencodeCache = null; }
}
// `upgrade` picks its install method itself; a bun global install is named, since that is how opencode2 ships here.
async function opencodeUpdate() {
  const bin = opencodeBin();
  if (!bin) throw new Error('opencode2를 찾지 못했습니다');
  const viaBun = (await realpath(bin)).includes('/.bun/install/global/');
  const update = await exec([bin, 'upgrade', ...(viaBun ? ['--method', 'bun'] : [])]);
  opencodeCache = null;
  try { return { update, restart: await restartOpencode() }; }
  catch (e: any) { return { update, restartError: String(e?.message || e) }; }
  finally { opencodeCache = null; }
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

const usageAuth = new UsageAuth(await UsageAuthStore.open(process.env.OMONITOR_USAGE_DIR || join(homedir(), '.omonitor/usage-auth')));
const planUsage = createPlanUsage(usageAuth);

// ── pasted images ──
// Pasted images are saved locally; their paths go into the message text for the agent to read.
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

// ── links and files opened on this Mac ──
// The installed dashboard app is a Chrome window, so a link opened from it lands in that app's Chrome rather than the
// Mac's default browser, and a file path cannot be opened at all. A dashboard served straight from this machine (not
// through the tunnel) hands both to the system: a URL to the default browser, a file or folder to its default app.
// Anything that would run or install when opened (an app, a .command script, a bare executable) is shown in Finder.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const fromThisMachine = (req: Request) => {
  if (req.headers.get('cf-connecting-ip')) return false;
  try { return LOOPBACK.has(new URL(req.headers.get('origin') || '').hostname); } catch { return false; }
};
const LAUNCHES = /\.(app|command|tool|terminal|pkg|mpkg|workflow|action|prefpane|saver|jar|webloc|inetloc|fileloc)$/i;
const OPENER = process.platform === 'darwin' ? 'open' : 'xdg-open';
async function openHere(target: string, cwd: string): Promise<OpenResult> {
  if (/^https?:\/\//i.test(target)) {
    await exec([OPENER, new URL(target).href]);
    return { opened: 'browser' };
  }
  const raw = target.startsWith('file://') ? fileURLToPath(target) : target.replace(/^~(?=\/|$)/, homedir());
  if (!isAbsolute(raw) && !isAbsolute(cwd)) throw new Error('세션 폴더를 몰라 상대 경로를 열 수 없습니다');
  // Agents write file:line (app/store.js:462); the line goes when no file carries it in its name.
  for (const p of new Set([raw, raw.replace(/:\d+(?:[-:]\d+)*$/, '')])) {
    const path = resolve(cwd, p);
    const st = await stat(path).catch(() => null);
    if (!st) continue;
    const bareExecutable = st.isFile() && !/.\.[^.]+$/.test(basename(path)) && (st.mode & 0o111) !== 0;
    if (LAUNCHES.test(path) || bareExecutable) {
      await exec(process.platform === 'darwin' ? ['open', '-R', path] : [OPENER, dirname(path)]);
      return { opened: 'finder' };
    }
    await exec([OPENER, path]);
    return { opened: 'app' };
  }
  throw new Error(`파일을 찾지 못했습니다: ${raw}`);
}

// ── images in tool results ──
// Like uploads, <img> loads them without the key: the session and tool call ids in the path are not guessable.
const TOOL_IMAGE_PATH = /^\/tool-images\/([^/]+)\/([^/]+)\/(\d+)$/;
async function toolImage(threadId: string, callId: string, n: number) {
  const img = await opencode.toolImage(threadId, callId, n);
  if (!img?.data) return new Response('not found', { status: 404 });
  return new Response(Buffer.from(img.data, 'base64'), { headers: { 'content-type': img.mimeType, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } });
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
// A summary covers every session folder and each worktree of their repos, so at most 8 git processes run at once.
let gitSlots = 8;
const gitQueue: (() => void)[] = [];
async function gitLimited(cwd: string, args: string[]) {
  if (gitSlots > 0) gitSlots--; else await new Promise<void>((r) => gitQueue.push(r));
  try { return await git(cwd, args); } finally { const next = gitQueue.shift(); if (next) next(); else gitSlots++; }
}
// A folder's worktree root and the git dir all its worktrees share. Cached for a minute.
type CwdRepo = { top: string; common: string };
const cwdRepos = new Map<string, { at: number; v: Promise<CwdRepo | null> }>();
function cwdRepo(cwd: string) {
  const hit = cwdRepos.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  const v = (async () => {
    const real = await realpath(cwd).catch(() => null);
    if (!real || !(await stat(real).then((s) => s.isDirectory(), () => false))) return null;
    const r = await gitLimited(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir']);
    const [top, common] = r.out.trim().split('\n');
    return r.code === 0 && top && common ? { top, common } : null;
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
async function gitSummary(threads: { id: string; cwd: string }[]): Promise<GitSummary> {
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
      out[t.id] = { repo: repo.common, worktree: own.path, branch: own.branch, head: own.head, removed: own.missing, inferred: false };
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
  '/app/usage-login.js',
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
const opencode = new OpencodeBridge();
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
      return Response.json({ mode: MOCK ? 'mock' : 'real', key: KEY, upstream: opencode.url });
    }
    if (url.pathname === '/ws') {
      if (MOCK) return new Response('mock mode', { status: 404 });
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      return server.upgrade(req, { data: { kind: 'relay', bridge: opencode } }) ? undefined : new Response('upgrade failed', { status: 400 });
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
    const ti = url.pathname.match(TOOL_IMAGE_PATH);
    if (ti) {
      try { return await toolImage(decodeURIComponent(ti[1]), decodeURIComponent(ti[2]), Number(ti[3])); }
      catch (e: any) { return new Response(String(e?.message || e), { status: 500 }); }
    }
    if (url.pathname.startsWith('/api/')) {
      if (!keyOk(req, url)) return new Response('bad key', { status: 401 });
      if (url.pathname === '/api/usage/auth' || url.pathname.startsWith('/api/usage/auth/')) return usageAuth.http(req, url);
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
        if (url.pathname === '/api/skills' && req.method === 'GET') return Response.json(await opencode.palette());
        if (url.pathname === '/api/threads/activity' && req.method === 'GET') return Response.json(await opencode.activity());
        const h = url.pathname.match(/^\/api\/threads\/([^/]+)\/history$/);
        if (h && req.method === 'GET') return Response.json(await opencode.history(decodeURIComponent(h[1])));
        const mt = url.pathname.match(/^\/api\/threads\/([^/]+)\/meta$/);
        if (mt && req.method === 'GET') return Response.json(await opencode.meta(decodeURIComponent(mt[1])));
        if (url.pathname === '/api/push' && req.method === 'GET') return Response.json(await push.info());
        if (url.pathname.startsWith('/api/push/') && req.method === 'POST') {
          const body = await req.json().catch(() => null);
          if (url.pathname === '/api/push/subscribe') return Response.json(await push.subscribe(body));
          if (url.pathname === '/api/push/unsubscribe') return Response.json(await push.unsubscribe(body));
          if (url.pathname === '/api/push/test') return Response.json(await push.test(body));
          if (url.pathname === '/api/push/request') return Response.json(await push.relay(body));
        }
        if (url.pathname === '/api/open' && req.method === 'POST') {
          if (!fromThisMachine(req)) return new Response('omonitor를 실행 중인 Mac에서 연 대시보드에서만 열 수 있습니다', { status: 403 });
          const body = await req.json().catch(() => null);
          if (typeof body?.target !== 'string' || !body.target.trim()) return new Response('열 대상이 없습니다', { status: 400 });
          return Response.json(await openHere(body.target.trim(), typeof body.cwd === 'string' ? body.cwd : ''));
        }
        if (url.pathname === '/api/usage' && req.method === 'GET') return Response.json(await planUsage());
        if (url.pathname === '/api/git' && req.method === 'GET') return Response.json(await gitGraph(url.searchParams.get('cwd') || ''));
        if (url.pathname === '/api/git/summary' && req.method === 'POST') {
          const body = await req.json().catch(() => null);
          if (!Array.isArray(body?.threads)) return new Response('threads 배열이 필요합니다', { status: 400 });
          const threads = body.threads.slice(0, 2000).filter((t: any) => typeof t?.id === 'string' && typeof t.cwd === 'string' && t.cwd.startsWith('/'));
          return Response.json(await gitSummary(threads));
        }
        if (url.pathname === '/api/opencode/version') return Response.json(await opencodeVersion());
        if (url.pathname === '/api/opencode/update' && req.method === 'POST') return Response.json(await opencodeUpdate());
        if (url.pathname === '/api/opencode/restart' && req.method === 'POST') return Response.json(await opencodeRestart());
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
      ws.data.client = ws.data.bridge.addClient({
        send: (data) => { ws.send(data); },
        close: (code, reason) => { try { ws.close(code, wsReason(reason)); } catch {} },
      });
    },
    message(ws, msg) {
      if (ws.data.kind === 'terminal') { terminals.message(ws, msg); return; }
      if (ws.data.client) void ws.data.bridge.message(ws.data.client, String(msg));
    },
    close(ws) {
      if (ws.data.kind === 'terminal') { terminals.close(ws); return; }
      if (ws.data.client) ws.data.bridge.removeClient(ws.data.client);
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
process.once('exit', () => { usageAuth.close(); void terminals.shutdown(); });

if (!MOCK && await opencodeInstalled()) {
  opencode.start();
  watchSessions({
    bridge: opencode, enabled: () => push.hasDevices(), notify: (m) => push.send(m), relay: (body) => push.relay(body),
    lastTurn: (id) => opencode.lastTurn(id),
    nameOf: async (id) => opencode.nameOf(id) || '이름 없는 세션',
  });
}

console.log(`omonitor → http://${HOST}:${PORT}  (${MOCK ? 'mock 시뮬레이터' : `opencode2 · ${opencode.url || 'opencode2 서버 연결 중'}`})`);
