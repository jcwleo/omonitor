// Open session shells, for the dashboard's 터미널 screen and session cleanup (server.ts -> terminal.ts).
const base = new URL('../', import.meta.url);
let key = null;

async function sessionKey() {
  const response = await fetch(new URL('api/config', base), { cache: 'no-store' });
  if (!response.ok) throw new Error('서버 연결을 확인하세요');
  key = (await response.json()).key;
  return key;
}

// The key changes on every server start, so a 401 fetches it again once.
async function call(method, path) {
  for (let retried = false; ; retried = true) {
    const response = await fetch(new URL(path, base), { method, cache: 'no-store', headers: { 'x-mc-key': key ?? await sessionKey() } });
    if (response.status === 401 && !retried) { key = null; continue; }
    if (!response.ok) throw new Error((await response.text()) || `요청 실패 (${response.status})`);
    return response.status === 204 ? null : response.json();
  }
}

export const listTerminals = () => call('GET', 'api/terminals');
export const closeTerminal = (id) => call('DELETE', `api/terminal?id=${encodeURIComponent(id)}`);
// onlyIdle keeps a shell that still runs a program and returns { closed: false, programs }.
export const closeSessionTerminal = (sessionId, onlyIdle = false) =>
  call('DELETE', `api/terminal?sessionId=${encodeURIComponent(sessionId)}${onlyIdle ? '&onlyIdle=1' : ''}`);
export const closeIdleTerminals = () => call('POST', 'api/terminals/close-idle');
// "/Users/leo/.bun/bin/bun run dev" -> "bun run dev"
export const programName = (command) => command.replace(/^\S*\//, '');
