// Web Push to the devices that turned it on: a session that finished its turn, stopped with an error, or waits for an
// answer. VAPID keys and device subscriptions live in ~/.omonitor/push.json.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import webpush from 'web-push';
import { z } from 'zod';

const subscription = z.object({
  endpoint: z.url().refine((u) => u.startsWith('https://')),
  keys: z.object({ p256dh: z.string().min(1).max(512), auth: z.string().min(1).max(256) }),
});
const subscribeRequest = z.object({ subscription });
const endpointRequest = z.object({ endpoint: z.url() });
const relayRequest = z.object({
  threadId: z.string().min(1).max(256),
  requestId: z.union([z.string().min(1).max(256), z.number()]),
  kind: z.enum(['question', 'approval']),
  title: z.string().max(200),
  body: z.string().max(500),
});

type Subscription = z.infer<typeof subscription> & { addedAt: number };
type PushFile = { vapid: { publicKey: string; privateKey: string }; subscriptions: Subscription[] };
export type PushMessage = { kind: 'done' | 'error' | 'question' | 'approval' | 'test'; title: string; body: string; threadId?: string };

export class PushError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const RELAY_WINDOW_MS = 10 * 60_000;

export class PushService {
  #data: PushFile | null = null;
  #relayed = new Map<string, number>();
  constructor(private readonly file: string, private readonly subject: string) {}

  async #load(): Promise<PushFile> {
    if (this.#data) return this.#data;
    try {
      this.#data = JSON.parse(await readFile(this.file, 'utf8')) as PushFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.#data = { vapid: webpush.generateVAPIDKeys(), subscriptions: [] };
      await this.#save();
    }
    return this.#data;
  }

  // Written to a temporary file and renamed, so a crash mid-write never leaves a broken key file behind.
  async #save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.#data, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  async info() {
    const d = await this.#load();
    return { publicKey: d.vapid.publicKey, devices: d.subscriptions.length };
  }

  async hasDevices() {
    return (await this.#load()).subscriptions.length > 0;
  }

  async subscribe(body: unknown) {
    const parsed = subscribeRequest.safeParse(body);
    if (!parsed.success) throw new PushError('푸시 구독 정보가 올바르지 않습니다');
    const d = await this.#load();
    const { endpoint, keys } = parsed.data.subscription;
    d.subscriptions = [...d.subscriptions.filter((s) => s.endpoint !== endpoint), { endpoint, keys, addedAt: Date.now() }];
    await this.#save();
    return { devices: d.subscriptions.length };
  }

  async unsubscribe(body: unknown) {
    const parsed = endpointRequest.safeParse(body);
    if (!parsed.success) throw new PushError('푸시 구독 주소가 올바르지 않습니다');
    const d = await this.#load();
    d.subscriptions = d.subscriptions.filter((s) => s.endpoint !== parsed.data.endpoint);
    await this.#save();
    return { devices: d.subscriptions.length };
  }

  async test(body: unknown) {
    const parsed = endpointRequest.safeParse(body);
    if (!parsed.success) throw new PushError('푸시 구독 주소가 올바르지 않습니다');
    const r = await this.send({ kind: 'test', title: 'omonitor', body: '이 기기로 푸시 알림이 옵니다' }, parsed.data.endpoint);
    if (!r.sent) throw new PushError('푸시를 보내지 못했습니다. 서버 로그를 확인하세요', 502);
    return r;
  }

  // Questions and approvals reach only the app-server connections subscribed to the session, so the dashboard that
  // receives one relays it here. With several dashboards open the same request arrives more than once.
  async relay(body: unknown) {
    const parsed = relayRequest.safeParse(body);
    if (!parsed.success) throw new PushError('알림 요청이 올바르지 않습니다');
    const { threadId, requestId, kind, title, body: text } = parsed.data;
    const now = Date.now();
    for (const [k, at] of this.#relayed) if (now - at > RELAY_WINDOW_MS) this.#relayed.delete(k);
    const key = `${threadId}:${requestId}`;
    if (this.#relayed.has(key)) return { sent: 0, removed: 0, duplicate: true };
    this.#relayed.set(key, now);
    return this.send({ kind, title, body: text, threadId });
  }

  async send(message: PushMessage, only?: string) {
    const d = await this.#load();
    const targets = d.subscriptions.filter((s) => !only || s.endpoint === only);
    if (only && !targets.length) throw new PushError('이 기기는 푸시 알림에 등록되어 있지 않습니다', 404);
    const urgent = message.kind !== 'done';
    const results = await Promise.allSettled(targets.map((s) => webpush.sendNotification(s, JSON.stringify(message), {
      TTL: urgent ? 600 : 3600,
      urgency: urgent ? 'high' : 'normal',
      vapidDetails: { subject: this.subject, publicKey: d.vapid.publicKey, privateKey: d.vapid.privateKey },
    })));
    // 404/410: the browser dropped the subscription (app removed, permission revoked), so the device is forgotten.
    const gone = new Set<string>();
    let sent = 0;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { sent++; return; }
      const code = (r.reason as { statusCode?: number } | undefined)?.statusCode;
      if (code === 404 || code === 410) gone.add(targets[i].endpoint);
      else console.error(`[push] ${new URL(targets[i].endpoint).host} ${code ?? ''} ${(r.reason as Error)?.message || r.reason}`);
    });
    if (gone.size) {
      d.subscriptions = d.subscriptions.filter((s) => !gone.has(s.endpoint));
      await this.#save();
    }
    return { sent, removed: gone.size };
  }
}

const clip = (s: string, n = 140) => {
  const t = s.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const nameOf = (t: { name?: string | null; preview?: string } | undefined) => t?.name || (t?.preview || '').slice(0, 40) || '이름 없는 세션';

// app-server broadcasts thread/status/changed to every connection, so this one connection, which never subscribes to a
// session, sees each session leave "active". The end of the turn is then confirmed by reading the session back, because
// a client subscribing to a busy session also makes app-server broadcast "idle" while the turn keeps running.
export function watchSessions(opts: {
  upstream: string;
  token: () => Promise<string>;
  enabled: () => Promise<boolean>;
  notify: (message: PushMessage) => Promise<unknown>;
  settleMs?: number;
}) {
  const settleMs = opts.settleMs ?? 2500;
  const names = new Map<string, string>();
  const status = new Map<string, string>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  let ws: WebSocket | null = null;
  let seq = 0;
  let retryMs = 1000;
  let stopped = false;

  const call = (method: string, params: unknown) => new Promise<any>((res, rej) => {
    const sock = ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) { rej(new Error('app-server에 연결되어 있지 않습니다')); return; }
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); rej(new Error('app-server 응답 시간 초과')); }, 10_000);
    pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
    sock.send(JSON.stringify({ id, method, params }));
  });

  async function settle(id: string) {
    timers.delete(id);
    if (status.get(id) === 'active' || !(await opts.enabled())) return;
    // thread/read loads a session that is not loaded, and omo may then auto-continue its goal or todo list. A session
    // that just left "active" is loaded and stays so through app-server's 30-minute idle unload; the list confirms it.
    const loaded: string[] = (await call('thread/loaded/list', {}))?.data || [];
    if (!loaded.includes(id)) return;
    const thread = (await call('thread/read', { threadId: id, includeTurns: true }))?.thread;
    if (!thread || thread.status?.type === 'active') return;
    const title = names.get(id) || nameOf(thread);
    const turn = (thread.turns || []).at(-1);
    if (thread.status?.type === 'systemError' || turn?.status === 'failed') {
      const why = turn?.error?.message ? `: ${clip(turn.error.message, 120)}` : '';
      await opts.notify({ kind: 'error', title, body: `오류로 멈췄습니다${why}`, threadId: id });
      return;
    }
    // An interrupted turn was stopped by the user, so it needs no alert.
    if (turn?.status !== 'completed') return;
    const last = [...(turn.items || [])].reverse().find((i: any) => i.type === 'agentMessage' && i.text?.trim());
    await opts.notify({ kind: 'done', title, body: last ? clip(last.text) : '작업을 마쳤습니다', threadId: id });
  }

  function onNotification(method: string, p: any) {
    switch (method) {
      case 'thread/started': if (p.thread?.id) { names.set(p.thread.id, nameOf(p.thread)); status.set(p.thread.id, p.thread.status?.type); } break;
      case 'thread/name/updated': if (p.threadId) names.set(p.threadId, p.threadName || p.name || names.get(p.threadId) || '이름 없는 세션'); break;
      case 'thread/deleted': names.delete(p.threadId); status.delete(p.threadId); break;
      case 'thread/status/changed': {
        const id: string = p.threadId;
        const prev = status.get(id), next = p.status?.type;
        status.set(id, next);
        clearTimeout(timers.get(id));
        timers.delete(id);
        if (prev === 'active' && (next === 'idle' || next === 'systemError')) {
          // A goal or todo continuation starts the next turn right away; waiting lets that cancel the alert.
          timers.set(id, setTimeout(() => settle(id).catch((e) => console.error('[push] 세션 상태를 확인하지 못했습니다:', e?.message || e)), settleMs));
        }
      } break;
    }
  }

  function retry() {
    if (stopped) return;
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  }

  async function connect() {
    if (stopped) return;
    let token: string;
    try { token = await opts.token(); } catch { retry(); return; }
    // Bun's client WebSocket can send headers and sends no Origin — both required by app-server.
    const sock = new WebSocket(opts.upstream, { headers: { Authorization: `Bearer ${token}` } } as any);
    ws = sock;
    sock.onopen = async () => {
      try {
        await call('initialize', { clientInfo: { name: 'omonitor-push', version: '0.1.0' }, capabilities: { experimentalApi: true } });
        retryMs = 1000;
        let cursor: string | null = null;
        do {
          const r = await call('thread/list', { archived: false, cursor, limit: 100 });
          for (const t of r?.data || []) { names.set(t.id, nameOf(t)); if (!status.has(t.id)) status.set(t.id, t.status?.type); }
          cursor = r?.nextCursor ?? null;
        } while (cursor);
      } catch (e: any) {
        console.error('[push] app-server 감시를 시작하지 못했습니다:', e?.message || e);
        sock.close();
      }
    };
    sock.onmessage = (e) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id != null && ('result' in m || 'error' in m)) {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
        return;
      }
      if (m.method && m.id == null) onNotification(m.method, m.params || {});
    };
    sock.onclose = () => {
      for (const p of pending.values()) p.rej(new Error('app-server 연결이 끊겼습니다'));
      pending.clear();
      if (ws === sock) ws = null;
      retry();
    };
  }

  void connect();
  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      ws?.close();
    },
  };
}
