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
};

export class TerminalError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class TerminalManager {
  private readonly records = new Map<string, RecordState>();
  private readonly sessions = new Map<string, string>();
  private readonly creating = new Map<string, Promise<Summary>>();
  private stopping = false;

  private summary(record: RecordState): Summary {
    return { id: record.id, sessionId: record.sessionId, cwd: record.cwd, status: record.status };
  }

  async http(req: Request, url: URL): Promise<Response> {
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
    };
    const current = record;
    this.records.set(current.id, current);
    this.sessions.set(current.sessionId, current.id);
    void proc.exited.then((exitCode) => {
      if (current.disposed) return;
      current.status = 'exited';
      current.exitCode = exitCode;
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
    await Promise.all([...this.records.values()].map((record) => this.dispose(record)));
  }
}
