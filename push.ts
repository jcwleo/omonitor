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

  // Questions and approvals reach only the omo host connections attached to the session: the backend's own connection
  // relays the ones it sees and every dashboard relays the ones it receives, so the same request arrives more than once.
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

// A reply may open with a quoted status block (omo's "> Ask: … For you: …" handoff); the notification starts at the
// reply itself, unless the whole reply is quoted.
const skipLeadingQuote = (s: string) => {
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length && (/^\s*>/.test(lines[i]) || !lines[i].trim())) i++;
  return i < lines.length ? lines.slice(i).join('\n') : s;
};
const clip = (s: string, n = 140) => {
  const t = skipLeadingQuote(s).replace(/```[\s\S]*?```/g, ' ').replace(/^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/gm, ' ').replace(/\|/g, ' ').replace(/[*_`#>]+/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// The omo host announces the end of every session's run (agent_settled) to every connection, so the backend's bridge
// sees each one, attached or not. A goal or todo continuation starts the next run right away, so an alert waits a moment
// and is dropped when the session runs again; the outcome is then read back from the session file, which reading does
// not load.
export function watchSessions(opts: {
  bridge: {
    on(event: 'settled', fn: (threadId: string) => void): unknown;
    on(event: 'question', fn: (q: { threadId: string; requestId: string; kind: 'question' | 'approval'; text: string }) => void): unknown;
    isRunning(threadId: string): boolean;
  };
  enabled: () => Promise<boolean>;
  notify: (message: PushMessage) => Promise<unknown>;
  relay: (body: unknown) => Promise<unknown>;
  lastTurn: (threadId: string) => Promise<any | null>;
  nameOf: (threadId: string) => Promise<string>;
  settleMs?: number;
}) {
  const settleMs = opts.settleMs ?? 2500;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function settle(id: string) {
    timers.delete(id);
    if (opts.bridge.isRunning(id) || !(await opts.enabled())) return;
    const turn = await opts.lastTurn(id);
    if (!turn) return;
    const title = await opts.nameOf(id);
    if (turn.status === 'failed') {
      const why = turn?.error?.message ? `: ${clip(turn.error.message, 120)}` : '';
      await opts.notify({ kind: 'error', title, body: `오류로 멈췄습니다${why}`, threadId: id });
      return;
    }
    // An interrupted turn was stopped by the user, so it needs no alert.
    if (turn?.status !== 'completed') return;
    const last = [...(turn.items || [])].reverse().find((i: any) => i.type === 'agentMessage' && i.text?.trim());
    await opts.notify({ kind: 'done', title, body: last ? clip(last.text) : '작업을 마쳤습니다', threadId: id });
  }

  opts.bridge.on('settled', (id) => {
    clearTimeout(timers.get(id));
    timers.set(id, setTimeout(() => settle(id).catch((e) => console.error('[push] 세션 상태를 확인하지 못했습니다:', e?.message || e)), settleMs));
  });
  opts.bridge.on('question', (q) => {
    void (async () => {
      if (!(await opts.enabled())) return;
      const ask = q.kind === 'question';
      await opts.relay({
        threadId: q.threadId, requestId: q.requestId, kind: q.kind, title: `${await opts.nameOf(q.threadId)} · ${ask ? '질문' : '승인 요청'}`.slice(0, 200),
        body: (q.text || (ask ? '답을 기다립니다' : '승인을 기다립니다')).slice(0, 500),
      });
    })().catch((e) => console.error('[push] 질문 알림을 보내지 못했습니다:', e?.message || e));
  });
  return { stop() { for (const t of timers.values()) clearTimeout(t); } };
}
