// omonitor updates itself from the git clone it runs from; it is not a published package, so "a new version" means
// commits on the upstream branch that the clone lacks. Shared by the server (dashboard button) and `omonitor update`.
// The server runs its .ts files and node_modules; pages, app/ scripts and styles are read from disk on every request,
// so an update that touches only those needs a page reload, and anything else needs the server restarted.
import { platform } from 'node:os';
import type { OmonitorUpdateResult, OmonitorVersion } from './src/protocol.ts';

export const SERVICE_LABEL = 'dev.omonitor'; // macOS LaunchAgent
export const SERVICE_UNIT = 'omonitor.service'; // Linux systemd user unit

const COMMITS_MAX = 10;
const FETCH_TIMEOUT_MS = 15_000;
const needsRestart = (files: string[]) => files.some((f) => f.endsWith('.ts') || f === 'package.json' || f === 'bun.lock');
const needsInstall = (files: string[]) => files.some((f) => f === 'package.json' || f === 'bun.lock');

async function run(cmd: string[], cwd: string, timeout = 60_000) {
  // GIT_TERMINAL_PROMPT=0: a remote that asks for credentials fails instead of waiting on a prompt nobody sees.
  const p = Bun.spawn(cmd, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (p.signalCode) throw new Error(`${cmd.slice(0, 2).join(' ')}이(가) ${Math.round(timeout / 1000)}초 안에 끝나지 않았습니다`);
  if (code !== 0) throw new Error((err.trim() || out.trim() || `${cmd.slice(0, 2).join(' ')} exit ${code}`).split('\n')[0]);
  return out.trim();
}
const git = (root: string, args: string[], timeout?: number) => run(['git', ...args], root, timeout);
const lines = (s: string) => s.split('\n').filter(Boolean);

/** Fetches the upstream branch and compares; null when omonitor does not run from a git clone whose branch has an upstream. */
export async function checkSelf(root: string): Promise<OmonitorVersion | null> {
  const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '');
  if (!upstream) return null;
  // Offline or unreachable: compare with what the last fetch brought and say why it is not fresh.
  let fetchError: string | null = null;
  await git(root, ['fetch', '--quiet', '--no-tags'], FETCH_TIMEOUT_MS).catch((e: Error) => { fetchError = e.message; });
  const [counts, current, latest, dirty] = await Promise.all([
    git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['rev-parse', '--short', '@{u}']),
    git(root, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  const [log, changed] = behind
    ? await Promise.all([git(root, ['log', `--max-count=${COMMITS_MAX}`, '--format=%h%x1f%ct%x1f%s', 'HEAD..@{u}']), git(root, ['diff', '--name-only', 'HEAD...@{u}'])])
    : ['', ''];
  const commits = lines(log).map((l) => { const [sha, ct, subject] = l.split('\x1f'); return { sha, subject, at: Number(ct) * 1000 }; });
  // Only a fast-forward runs unattended: local commits or edits are someone's work in progress, never merged or stashed here.
  const blocked = !behind ? null : ahead ? `로컬 커밋 ${ahead}개가 있어 자동으로 합치지 않습니다` : dirty ? '커밋하지 않은 변경이 있어 자동으로 업데이트하지 않습니다' : null;
  return { current, latest, upstream, behind, ahead, commits, updateAvailable: behind > 0, blocked, restartNeeded: needsRestart(lines(changed)), fetchError, checkedAt: Date.now() };
}

export async function applySelf(root: string): Promise<Omit<OmonitorUpdateResult, 'restarting'>> {
  const v = await checkSelf(root);
  if (!v) throw new Error('git으로 받은 폴더(업스트림이 있는 브랜치)에서 실행 중이 아니라 업데이트할 수 없습니다');
  if (v.fetchError) throw new Error(`최신 버전을 받지 못했습니다: ${v.fetchError}`);
  if (v.blocked) throw new Error(`${v.blocked}. 직접 git pull 한 뒤 omonitor restart 하세요`);
  if (!v.behind) return { from: v.current, to: v.current, installed: false, restartNeeded: false };
  const before = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['merge', '--ff-only', '--quiet', '@{u}']);
  const changed = lines(await git(root, ['diff', '--name-only', before, 'HEAD']));
  const to = await git(root, ['rev-parse', '--short', 'HEAD']);
  const installed = needsInstall(changed);
  // --frozen-lockfile installs exactly the pulled lockfile and leaves the tree clean for the next update.
  if (installed) await run([process.execPath, 'install', '--frozen-lockfile'], root, 180_000).catch((e: Error) => { throw new Error(`${to}로 받았지만 bun install에 실패했습니다: ${e.message}`); });
  return { from: v.current, to, installed, restartNeeded: needsRestart(changed) };
}

/** Whether this process is the service's main process, which the service manager starts again after an error exit
 * (KeepAlive SuccessfulExit=false / Restart=on-failure, see bin/omonitor.ts). bun start or omonitor run in a terminal is not. */
export function isServiceProcess(): boolean {
  const mac = platform() === 'darwin';
  if (!mac && platform() !== 'linux') return false;
  const cmd = mac ? ['launchctl', 'print', `gui/${process.getuid?.() ?? 0}/${SERVICE_LABEL}`] : ['systemctl', '--user', 'show', '-p', 'MainPID', '--value', SERVICE_UNIT];
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' });
  if (r.exitCode !== 0) return false;
  const out = r.stdout.toString();
  return Number(mac ? out.match(/^\s*pid = (\d+)/m)?.[1] : out.trim()) === process.pid;
}
