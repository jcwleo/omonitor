#!/usr/bin/env bun
// omonitor CLI: run the dashboard in the foreground, or keep it running in the background as a per-user service
// (macOS LaunchAgent, Linux systemd user unit) that starts again at login.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const ROOT = dirname(import.meta.dir);
const HOME = homedir();
const LOG = join(HOME, '.omonitor/server.log');
const MAC = platform() === 'darwin';
const LINUX = platform() === 'linux';
const LABEL = 'dev.omonitor';
const DOMAIN = `gui/${process.getuid?.() ?? 0}`;
const UNIT_NAME = 'omonitor.service';
const SERVICE_FILE = MAC
  ? join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`)
  : join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'systemd/user', UNIT_NAME);
// Settings copied from the installing shell into the service, together with its PATH so the service finds the same
// omo, bun and node.
const PASS_ENV = ['OMO_APP_SERVER_URL', 'OMO_WS_TOKEN_FILE', 'OMONITOR_ORIGINS'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function sh(cmd: string[]) {
  const r = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function installedPort() {
  if (!existsSync(SERVICE_FILE)) return null;
  const t = await readFile(SERVICE_FILE, 'utf8');
  const m = t.match(/<key>PORT<\/key>\s*<string>(\d+)<\/string>/) || t.match(/^Environment="PORT=(\d+)"$/m);
  return m ? Number(m[1]) : null;
}
const portOf = async () => Number(process.env.PORT || (await installedPort()) || 4800);
const urlOf = (port: number) => `http://127.0.0.1:${port}`;

// 'omonitor' when our dashboard answers, 'other' when something else holds the port, null when it is free.
async function probe(port: number): Promise<'omonitor' | 'other' | null> {
  try {
    const r = await fetch(`${urlOf(port)}/api/config`, { signal: AbortSignal.timeout(1500) });
    const j = r.ok ? await r.json().catch(() => null) : null;
    return j && 'mode' in j && 'upstream' in j ? 'omonitor' : 'other';
  } catch (e: any) {
    return e?.name === 'TimeoutError' ? 'other' : null;
  }
}

const loaded = () => (MAC ? sh(['launchctl', 'print', `${DOMAIN}/${LABEL}`]).ok : sh(['systemctl', '--user', 'is-active', '--quiet', UNIT_NAME]).ok);

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function plist(env: Record<string, string>) {
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(join(ROOT, 'bin/omonitor.ts'))}</string><string>run</string></array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
}
function unit(env: Record<string, string>) {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return `[Unit]
Description=omonitor dashboard for omo
After=network.target

[Service]
ExecStart=${q(process.execPath)} ${q(join(ROOT, 'bin/omonitor.ts'))} run
WorkingDirectory=${ROOT}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=10
StandardOutput=append:${LOG}
StandardError=append:${LOG}

[Install]
WantedBy=default.target
`;
}

async function waitUntil(check: () => Promise<boolean> | boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await check()) return true;
  return false;
}

async function start() {
  if (!MAC && !LINUX) fail('백그라운드 서비스는 macOS와 Linux에서만 지원합니다. `omonitor run`으로 실행하세요.');
  const port = await portOf();
  const was = loaded();
  if (!was && (await probe(port))) fail(`포트 ${port}을 이미 다른 프로세스가 쓰고 있습니다. 직접 띄운 omonitor라면 먼저 종료하거나, PORT=<다른 포트> omonitor start로 실행하세요.`);
  const env: Record<string, string> = { PATH: process.env.PATH || '/usr/bin:/bin', PORT: String(port) };
  for (const k of PASS_ENV) if (process.env[k]) env[k] = process.env[k]!;
  await mkdir(dirname(LOG), { recursive: true });
  await mkdir(dirname(SERVICE_FILE), { recursive: true });
  await writeFile(SERVICE_FILE, MAC ? plist(env) : unit(env));
  if (MAC) {
    // A changed plist only takes effect after the job is unloaded and loaded again.
    if (was) { sh(['launchctl', 'bootout', `${DOMAIN}/${LABEL}`]); await waitUntil(() => !loaded(), 5000); }
    const r = sh(['launchctl', 'bootstrap', DOMAIN, SERVICE_FILE]);
    if (!r.ok) fail(`LaunchAgent를 등록하지 못했습니다: ${r.err || r.out}`);
  } else {
    sh(['systemctl', '--user', 'daemon-reload']);
    const r = sh(['systemctl', '--user', 'enable', '--now', UNIT_NAME]);
    if (!r.ok) fail(`systemd 사용자 서비스를 켜지 못했습니다: ${r.err || r.out}`);
    if (was) sh(['systemctl', '--user', 'restart', UNIT_NAME]);
  }
  if (!(await waitUntil(async () => (await probe(port)) === 'omonitor', 20000))) fail(`서비스는 등록했지만 ${urlOf(port)}이 응답하지 않습니다. 로그를 확인하세요: omonitor logs`);
  console.log(`omonitor가 백그라운드에서 실행 중입니다 → ${urlOf(port)}\n로그인할 때마다 자동으로 시작합니다. 끄려면 omonitor stop`);
}

async function stop() {
  if (!existsSync(SERVICE_FILE) && !loaded()) return console.log('백그라운드 서비스가 설치되어 있지 않습니다.');
  if (MAC) sh(['launchctl', 'bootout', `${DOMAIN}/${LABEL}`]);
  else sh(['systemctl', '--user', 'disable', '--now', UNIT_NAME]);
  await rm(SERVICE_FILE, { force: true });
  if (LINUX) sh(['systemctl', '--user', 'daemon-reload']);
  console.log('omonitor를 멈추고 로그인 시 자동 시작을 껐습니다. omo app-server는 그대로 둡니다 (끄려면 omo app-server daemon stop).');
}

async function restart() {
  if (!existsSync(SERVICE_FILE)) fail('백그라운드 서비스가 설치되어 있지 않습니다. omonitor start로 시작하세요.');
  const r = MAC ? sh(['launchctl', 'kickstart', '-k', `${DOMAIN}/${LABEL}`]) : sh(['systemctl', '--user', 'restart', UNIT_NAME]);
  if (!r.ok) fail(`다시 시작하지 못했습니다: ${r.err || r.out}`);
  const port = await portOf();
  if (!(await waitUntil(async () => (await probe(port)) === 'omonitor', 20000))) fail(`${urlOf(port)}이 응답하지 않습니다. 로그를 확인하세요: omonitor logs`);
  console.log(`다시 시작했습니다 → ${urlOf(port)}`);
}

async function status() {
  const port = await portOf();
  const svc = existsSync(SERVICE_FILE) ? (loaded() ? '실행 중 (로그인 시 자동 시작)' : '설치됨, 멈춤') : '설치 안 됨';
  const web = await probe(port);
  const omo = Bun.which('omo') ? sh(['omo', 'app-server', 'daemon', 'status']) : null;
  let app = 'omo 명령을 찾지 못했습니다';
  if (omo) { try { const j = JSON.parse(omo.out); app = `${j.status}${j.listen ? ` (${j.listen})` : ''}`; } catch { app = omo.err || omo.out; } }
  console.log(`서비스      ${svc}\n대시보드    ${web === 'omonitor' ? `응답함 → ${urlOf(port)}` : web === 'other' ? `포트 ${port}을 다른 프로세스가 사용 중` : '응답 없음'}\napp-server  ${app}\n로그        ${LOG}`);
}

// Started by the service at login, so bring the omo app-server up first; `daemon start` is a no-op when it already runs.
function ensureAppServer() {
  if (!Bun.which('omo')) return console.warn('[omonitor] omo 명령을 찾지 못해 app-server를 시작하지 않았습니다.');
  const args = ['omo', 'app-server', 'daemon', 'start'];
  if (process.env.OMO_APP_SERVER_URL) args.push('--listen', process.env.OMO_APP_SERVER_URL);
  const r = sh(args);
  console.log(`[omonitor] omo app-server daemon start: ${r.ok ? r.out : `실패 ${r.err || r.out}`}`);
}

async function run() {
  if (!process.argv.includes('--mock')) ensureAppServer();
  await import('../server.ts');
}

const HELP = `omonitor — omo 세션 대시보드

  omonitor start     백그라운드 서비스로 실행하고 로그인할 때마다 자동으로 시작합니다
  omonitor stop      서비스를 멈추고 자동 시작을 끕니다
  omonitor restart   서비스를 다시 시작합니다 (업데이트 후)
  omonitor status    서비스·대시보드·omo app-server 상태
  omonitor open      브라우저에서 대시보드를 엽니다
  omonitor logs      서버 로그를 따라 봅니다
  omonitor run       터미널에서 직접 실행합니다 (--mock: 시뮬레이터)

환경 변수: PORT (4800), OMO_APP_SERVER_URL, OMO_WS_TOKEN_FILE — start 할 때의 값이 서비스에 저장됩니다.`;

const cmd = process.argv[2];
switch (cmd) {
  case 'start': await start(); break;
  case 'stop': await stop(); break;
  case 'restart': await restart(); break;
  case 'status': await status(); break;
  case 'open': { const r = sh([MAC ? 'open' : 'xdg-open', urlOf(await portOf())]); if (!r.ok) fail(r.err || r.out); break; }
  case 'logs': { if (!existsSync(LOG)) fail(`아직 로그가 없습니다: ${LOG}`); await Bun.spawn(['tail', '-n', '100', '-f', LOG], { stdout: 'inherit', stderr: 'inherit' }).exited; break; }
  case 'run': await run(); break;
  case undefined: case 'help': case '-h': case '--help': console.log(HELP); break;
  default: fail(`알 수 없는 명령: ${cmd}\n\n${HELP}`);
}
