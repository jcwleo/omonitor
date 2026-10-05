import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { z } from 'zod';
import type { ServerWebSocket } from 'bun';

const sessionId = z.string().min(1).max(256).regex(/^[\w.-]+$/);
const terminalId = z.uuid();
const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(200) };
const createRequest = z.strictObject({
  sessionId,
  cwd: z.string().min(1).max(4096).refine((s) => isAbsolute(s) && !s.includes('\0')),
  ...dimensions,
});
const clientMessage = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('input'), data: z.string().min(1).max(65536) }),
  z.strictObject({ type: z.literal('resize'), ...dimensions }),
]);

export type TerminalSocketData = {
  readonly kind: 'terminal';
  readonly id: string;
  // Socket attachment state must survive the asynchronous mirror flush.
  closed: boolean;
  detach?: () => void;
};
export type SocketData = TerminalSocketData | { readonly kind: 'relay'; up?: WebSocket; queue: string[] };
type Message =
  | { readonly type: 'snapshot' | 'output'; readonly data: string }
  | { readonly type: 'exit'; readonly exitCode: number }
  | { readonly type: 'error'; readonly message: string };
type Summary = {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly status: 'running' | 'exited';
};
type Program = { readonly pid: number; readonly command: string };
type Usage = { readonly memoryKb: number; readonly programs: readonly Program[] };
type Proc = { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly rss: number; readonly tty: string; readonly command: string };
export type TerminalPolicy = {
  // An unwatched shell running no program is closed after this long without input or output.
  readonly idleMs: number;
  // An exited shell nobody is watching keeps its screen this long.
  readonly exitedMs: number;
  readonly sweepMs: number;
};
const defaultPolicy: TerminalPolicy = { idleMs: 24 * 60 * 60 * 1000, exitedMs: 10 * 60 * 1000, sweepMs: 5 * 60 * 1000 };
// A record owns the live PTY, parser state, and connected subscribers.
type RecordState = {
  readonly id: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly mirror: InstanceType<typeof headless.Terminal>;
  readonly addon: InstanceType<typeof serialize.SerializeAddon>;
  readonly subscribers: Set<(message: Message) => void>;
  readonly decoder: TextDecoder;
  readonly process: Bun.Subprocess;
  readonly terminal: Bun.Terminal;
  status: 'running' | 'exited';
  exitCode: number | null;
  pendingBytes: number;
  disposed: boolean;
  readonly startedAt: number;
  lastActivityAt: number;
  exitedAt: number | null;
};

export class TerminalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class TerminalManager {
  private readonly records = new Map<string, RecordState>();
  private readonly sessions = new Map<string, string>();
  private readonly creating = new Map<string, Promise<Summary>>();
  private stopping = false;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(private readonly policy: TerminalPolicy = defaultPolicy) {
    this.sweeper = setInterval(() => {
      if (this.stopping) return;
      this.reclaim(policy.idleMs, policy.exitedMs).then((closed) => {
        if (closed) console.log(`[terminal] 쓰지 않는 터미널 ${closed}개를 닫았습니다`);
      }, (error: unknown) => console.error('[terminal cleanup]', error));
    }, policy.sweepMs);
    this.sweeper.unref();
  }

  private summary(record: RecordState): Summary {
    return { id: record.id, sessionId: record.sessionId, cwd: record.cwd, status: record.status };
  }

  async http(req: Request, url: URL): Promise<Response> {
    if (url.pathname === '/api/terminals' && req.method === 'GET') {
      const { idleMs, exitedMs } = this.policy;
      return Response.json({ terminals: await this.list(), policy: { idleMs, exitedMs } });
    }
    if (url.pathname === '/api/terminals/close-idle' && req.method === 'POST') return Response.json({ closed: await this.reclaim(0, 0) });
    if (url.pathname !== '/api/terminal') return new Response('not found', { status: 404 });
    switch (req.method) {
      case 'POST': {
        if (!(req.headers.get('content-type') || '').startsWith('application/json'))
          throw new TerminalError(415, 'JSON 요청이 필요합니다');
        if (Number(req.headers.get('content-length')) > 16384)
          throw new TerminalError(413, '요청이 너무 큽니다');
        // Read incrementally: chunked requests must obey the same bound as Content-Length.
        const reader = req.body?.getReader();
        if (!reader) throw new TerminalError(400, '빈 요청입니다');
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 16384) {
              await reader.cancel();
              throw new TerminalError(413, '요청이 너무 큽니다');
            }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
        let body: unknown;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (error) {
          if (error instanceof SyntaxError) throw new TerminalError(400, '잘못된 JSON입니다');
          throw error;
        }
        const parsed = createRequest.safeParse(body);
        if (!parsed.success) throw new TerminalError(400, '잘못된 터미널 생성 요청입니다');
        return Response.json(await this.create(parsed.data));
      }
      case 'GET': {
        const parsed = sessionId.safeParse(url.searchParams.get('sessionId'));
        if (!parsed.success) throw new TerminalError(400, '잘못된 세션 ID입니다');
        const id = this.sessions.get(parsed.data);
        const record = id ? this.records.get(id) : undefined;
        return Response.json(record ? this.summary(record) : null);
      }
      case 'DELETE': {
        if (url.searchParams.has('sessionId')) return Response.json(await this.closeSession(url));
        const id = this.parseId(url.searchParams.get('id'));
        const record = this.records.get(id);
        if (!record) throw new TerminalError(404, '터미널을 찾지 못했습니다');
        await this.dispose(record);
        return new Response(null, { status: 204 });
      }
      default: return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, POST, DELETE' } });
    }
  }

  parseId(value: unknown): string {
    const parsed = terminalId.safeParse(value);
    if (!parsed.success) throw new TerminalError(400, '잘못된 터미널 ID입니다');
    return parsed.data;
  }

  has(id: string): boolean { return this.records.has(id); }

  // Every shell, newest activity first, with its process tree's memory and the programs running in it.
  private async list() {
    const records = [...this.records.values()];
    const usage = await this.usage(records);
    return records.filter((record) => !record.disposed).map((record) => ({
      ...this.summary(record), exitCode: record.exitCode, startedAt: record.startedAt,
      lastActivityAt: record.lastActivityAt, exitedAt: record.exitedAt, viewers: record.subscribers.size,
      ...(usage.get(record.id) ?? { memoryKb: 0, programs: [] }),
    })).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  // One ps snapshot for the given shells: the memory of each shell's process tree and the programs started from its
  // prompt. A program is a descendant on the shell's TTY in a job (process group) of its own; prompt helpers stay in
  // the shell's group or run on a pty of their own, so an idle shell reports none.
  private async usage(records: readonly RecordState[]): Promise<Map<string, Usage>> {
    const out = new Map<string, Usage>();
    const running = records.filter((record) => record.status === 'running' && !record.disposed);
    if (!running.length) return out;
    const ps = Bun.spawn(['ps', '-A', '-o', 'pid=,ppid=,pgid=,rss=,tty=,args='], { stdout: 'pipe', stderr: 'ignore' });
    const [text, code] = await Promise.all([new Response(ps.stdout).text(), ps.exited]);
    if (code !== 0) throw new TerminalError(500, '프로세스 목록을 읽지 못했습니다');
    const byPid = new Map<number, Proc>();
    const children = new Map<number, Proc[]>();
    for (const line of text.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, ppid, pgid, rss, tty, command] = match;
      const proc: Proc = { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), rss: Number(rss), tty: String(tty), command: String(command) };
      byPid.set(proc.pid, proc);
      const siblings = children.get(proc.ppid);
      if (siblings) siblings.push(proc); else children.set(proc.ppid, [proc]);
    }
    for (const record of running) {
      const shell = byPid.get(record.process.pid);
      if (!shell) { out.set(record.id, { memoryKb: 0, programs: [] }); continue; }
      let memoryKb = shell.rss;
      const programs: Program[] = [];
      const stack = [...(children.get(shell.pid) ?? [])];
      for (let proc = stack.pop(); proc; proc = stack.pop()) {
        memoryKb += proc.rss;
        if (proc.tty === shell.tty && proc.pgid !== shell.pgid) programs.push({ pid: proc.pid, command: proc.command.slice(0, 300) });
        stack.push(...(children.get(proc.pid) ?? []));
      }
      programs.sort((a, b) => a.pid - b.pid);
      out.set(record.id, { memoryKb, programs });
    }
    return out;
  }

  // Closes unwatched shells that ran no program and saw no input or output for idleFor, and unwatched exited ones
  // older than exitedFor. A shell still running a program is never closed here.
  private async reclaim(idleFor: number, exitedFor: number): Promise<number> {
    const now = Date.now();
    const unwatched = (record: RecordState) => !record.disposed && record.subscribers.size === 0;
    const due = [...this.records.values()].filter((record) => unwatched(record) && (record.status === 'exited'
      ? now - (record.exitedAt ?? now) >= exitedFor
      : now - record.lastActivityAt >= idleFor));
    const usage = await this.usage(due);
    const doomed = due.filter((record) => unwatched(record) && (record.status === 'exited' || usage.get(record.id)?.programs.length === 0));
    const results = await Promise.allSettled(doomed.map((record) => this.dispose(record)));
    for (const result of results) if (result.status === 'rejected') console.error('[terminal cleanup]', result.reason);
    return results.filter((result) => result.status === 'fulfilled').length;
  }

  // Closes a session's shell when the session is deleted or archived. onlyIdle keeps a shell that still runs a program
  // and reports what runs there.
  private async closeSession(url: URL): Promise<{ closed: boolean; programs: string[] }> {
    const parsed = sessionId.safeParse(url.searchParams.get('sessionId'));
    if (!parsed.success) throw new TerminalError(400, '잘못된 세션 ID입니다');
    const id = this.sessions.get(parsed.data);
    const record = id ? this.records.get(id) : undefined;
    if (!record) return { closed: false, programs: [] };
    if (url.searchParams.get('onlyIdle') === '1') {
      const programs = (await this.usage([record])).get(record.id)?.programs ?? [];
      if (programs.length) return { closed: false, programs: programs.map((program) => program.command) };
    }
    await this.dispose(record);
    return { closed: true, programs: [] };
  }

  private async create(options: z.infer<typeof createRequest>): Promise<Summary> {
    if (this.stopping) throw new TerminalError(503, '서버가 종료 중입니다');
    const pending = this.creating.get(options.sessionId);
    if (pending) return pending;
    const create = this.spawn(options);
    this.creating.set(options.sessionId, create);
    try { return await create; }
    finally { this.creating.delete(options.sessionId); }
  }

  private async spawn(options: z.infer<typeof createRequest>): Promise<Summary> {
    let cwd: string;
    try {
      cwd = await realpath(options.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new TerminalError(400, '작업 경로가 디렉터리가 아닙니다');
    } catch (error) {
      if (error instanceof TerminalError) throw error;
      if (error instanceof Error) throw new TerminalError(400, '작업 경로를 찾거나 열지 못했습니다');
      throw error;
    }
    if (this.stopping) throw new TerminalError(503, '서버가 종료 중입니다');
    const existingId = this.sessions.get(options.sessionId);
    const existing = existingId ? this.records.get(existingId) : undefined;
    // POST is idempotent even after exit. Explicit restart is DELETE followed by POST.
    if (existing) return this.summary(existing);
    const shell = process.env.SHELL || '/bin/sh';
    const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'USER']) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) {
      env.LANG = 'en_US.UTF-8';
      env.LC_CTYPE = 'en_US.UTF-8';
      delete env.LC_ALL;
    }
    const mirror = new headless.Terminal({
      cols: options.cols, rows: options.rows, scrollback: 2000, allowProposedApi: true,
    });
    const addon = new serialize.SerializeAddon();
    // The addon uses the shared core, but its published activate type names the browser Terminal.
    mirror.loadAddon({
      activate(terminal) { Reflect.apply(addon.activate, addon, [terminal]); },
      dispose() { addon.dispose(); },
    });
    let record: RecordState | undefined;
    let proc: Bun.Subprocess;
    const manager = this;
    try {
      proc = Bun.spawn([shell, '-i'], {
        cwd, env,
        terminal: {
          cols: options.cols, rows: options.rows,
          data(_terminal, bytes) {
            if (!record || record.disposed) return;
            record.lastActivityAt = Date.now();
            // Bound parser backlog without silently dropping state and corrupting future snapshots.
            record.pendingBytes += bytes.byteLength;
            if (record.pendingBytes > 8 * 1024 * 1024) {
              for (const subscriber of record.subscribers)
                subscriber({ type: 'error', message: '터미널 출력 처리 한도를 초과했습니다' });
              void manager.dispose(record).catch((error: unknown) => {
                if (!(error instanceof Error)) throw error;
                console.error('[terminal cleanup]', error);
              });
              return;
            }
            const current = record;
            const data = current.decoder.decode(bytes, { stream: true });
            current.mirror.write(data, () => {
              current.pendingBytes -= bytes.byteLength;
              if (!current.disposed)
                for (const subscriber of current.subscribers) subscriber({ type: 'output', data });
            });
          },
        },
      });
    } catch (error) {
      mirror.dispose();
      if (error instanceof Error) throw new TerminalError(500, '셸을 시작하지 못했습니다');
      throw error;
    }
    const terminal = proc.terminal;
    if (!terminal) {
      proc.kill();
      mirror.dispose();
      throw new TerminalError(500, 'PTY를 시작하지 못했습니다');
    }
    record = {
      id: crypto.randomUUID(), sessionId: options.sessionId, cwd, mirror, addon,
      subscribers: new Set(), decoder: new TextDecoder(), process: proc, terminal,
      status: 'running', exitCode: null, pendingBytes: 0, disposed: false,
      startedAt: Date.now(), lastActivityAt: Date.now(), exitedAt: null,
    };
    const current = record;
    this.records.set(current.id, current);
    this.sessions.set(current.sessionId, current.id);
    void proc.exited.then((exitCode) => {
      if (current.disposed) return;
      current.status = 'exited';
      current.exitCode = exitCode;
      current.exitedAt = Date.now();
      current.terminal.close();
      current.mirror.write(current.decoder.decode(), () => {
        if (!current.disposed)
          for (const subscriber of current.subscribers) subscriber({ type: 'exit', exitCode });
      });
    });
    return this.summary(current);
  }

  open(ws: ServerWebSocket<SocketData>): void {
    if (ws.data.kind !== 'terminal') return;
    const socketData = ws.data;
    const record = this.records.get(ws.data.id);
    if (!record) { ws.close(1008, '터미널을 찾지 못했습니다'); return; }
    const send = (message: Message) => {
      if (socketData.closed) return;
      if (ws.send(JSON.stringify(message)) === -1) ws.close(1013, '터미널 수신이 너무 느립니다');
    };
    ws.data.detach = () => record.subscribers.delete(send);
    // Snapshot + subscription happen inside the parser sentinel, before any later writes.
    // Live output is published only after parsing, so attach never duplicates pre-snapshot data.
    record.mirror.write('', () => {
      if (socketData.closed || record.disposed) return;
      let data = '';
      for (const scrollback of [2000, 500, 0]) {
        data = record.addon.serialize({ scrollback });
        if (Buffer.byteLength(data) <= 8 * 1024 * 1024) break;
      }
      send({ type: 'snapshot', data });
      record.subscribers.add(send);
      if (record.exitCode !== null) send({ type: 'exit', exitCode: record.exitCode });
    });
  }

  message(ws: ServerWebSocket<SocketData>, raw: string | Buffer): void {
    if (ws.data.kind !== 'terminal') return;
    try {
      if (typeof raw !== 'string' || Buffer.byteLength(raw) > 256 * 1024)
        throw new TerminalError(400, '잘못되거나 너무 큰 터미널 메시지입니다');
      let value: unknown;
      try { value = JSON.parse(raw); }
      catch (error) {
        if (error instanceof SyntaxError) throw new TerminalError(400, '잘못된 JSON입니다');
        throw error;
      }
      const parsed = clientMessage.safeParse(value);
      if (!parsed.success) throw new TerminalError(400, '잘못된 터미널 메시지입니다');
      const record = this.records.get(ws.data.id);
      if (!record || record.status !== 'running') throw new TerminalError(409, '터미널이 종료되었습니다');
      switch (parsed.data.type) {
        case 'input':
          record.lastActivityAt = Date.now();
          record.terminal.write(parsed.data.data);
          break;
        case 'resize': {
          const { cols, rows } = parsed.data;
          record.mirror.write('', () => {
            if (record.disposed || record.status !== 'running') return;
            record.mirror.resize(cols, rows);
            record.terminal.resize(cols, rows);
          });
          break;
        }
        default: parsed.data satisfies never;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      ws.send(JSON.stringify({ type: 'error', message: error instanceof TerminalError ? error.message : '터미널 요청 처리에 실패했습니다' }));
    }
  }

  close(ws: ServerWebSocket<SocketData>): void {
    if (ws.data.kind !== 'terminal') return;
    ws.data.closed = true;
    ws.data.detach?.();
  }

  private dispose(record: RecordState): Promise<void> {
    if (record.disposed) return Promise.resolve();
    // Interactive jobs use separate process groups. Enumerate the tree, not just the shell group.
    const descendants = new Set(record.status === 'running' ? [record.process.pid] : []);
    const signal = (pid: number, name: 'SIGSTOP' | 'SIGKILL') => {
      try { process.kill(pid, name); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
    };
    for (const pid of descendants) signal(pid, 'SIGSTOP');
    // Freeze each discovered generation and rescan; children cannot fork past the final scan.
    let size = -1;
    while (size !== descendants.size) {
      size = descendants.size;
      const listing = Bun.spawnSync(['ps', '-axo', 'pid=,ppid='], { stdout: 'pipe', stderr: 'pipe' });
      if (listing.exitCode !== 0) throw new TerminalError(500, '하위 프로세스를 조회하지 못했습니다');
      const tree = listing.stdout.toString().trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
      for (const [pid, parent] of tree) {
        if (pid !== undefined && parent !== undefined && descendants.has(parent) && !descendants.has(pid)) {
          descendants.add(pid);
          signal(pid, 'SIGSTOP');
        }
      }
    }
    record.disposed = true;
    for (const pid of [...descendants].reverse()) signal(pid, 'SIGKILL');
    record.terminal.close();
    for (const subscriber of record.subscribers) subscriber({ type: 'exit', exitCode: 137 });
    record.subscribers.clear();
    record.mirror.dispose();
    this.records.delete(record.id);
    this.sessions.delete(record.sessionId);
    return record.process.exited.then(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.records.values()].map((record) => this.dispose(record)));
  }
}
