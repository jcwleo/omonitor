// SessionClient — the only thing the UI talks to. MockClient (app/mock-client.js) and RealClient
// below implement the same contract, so swapping them needs no UI change.
import type { RequestId, RpcNotification, ServerRequest, Skill, Item, InitializeParams, Turn, Model, OmoVersion, OmoUpdateResult } from './protocol';

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface ConnectionEvent { state: ConnectionState; attempt?: number; retryInMs?: number; reconnected?: boolean }

export interface SessionClient {
  connect(): Promise<void>;
  close(): void;
  request<R = unknown>(method: string, params?: unknown): Promise<R>;
  /** Answer a server → client request (approvals). */
  respond(id: RequestId, result: unknown): void;
  on(ev: 'notification', cb: (n: RpcNotification) => void): () => void;
  on(ev: 'serverRequest', cb: (r: ServerRequest) => void): () => void;
  on(ev: 'connection', cb: (e: ConnectionEvent) => void): () => void;
  /** Bun backend REST, not part of app-server. */
  backend?: {
    listSkills(): Promise<Skill[]>;
    /** Saved-session history from the session file; unlike thread/read it does not load the session. */
    history(threadId: string): Promise<Turn[]>;
    /** Thread id → last conversation time (ms) from each session file; app-server's updatedAt also moves on metadata. */
    activity(): Promise<Record<string, number>>;
    /** Saves a pasted image; its path goes into the message text because turn input takes no image items. */
    upload(file: Blob): Promise<{ path: string; url: string }>;
    /** Subagent runs (omo.task.updated shape) and context usage, read from the session file. */
    meta(threadId: string): Promise<{ agents: unknown[]; usage: { used: number; window: number } | null }>;
    restoreTodos(threadId: string): Promise<Item[]>;
    /** Models of extension-registered providers (Claude subscription) that model/list does not return. */
    extraModels(): Promise<Model[]>;
    omoVersion(): Promise<OmoVersion>;
    /** Updates omo and restarts the app-server daemon, which ends every session running under it. */
    omoUpdate(): Promise<OmoUpdateResult>;
  };
}

export interface RealClientOptions {
  /** Browser ⇄ Bun backend socket. The backend holds the app-server token. */
  url?: string;
  /** Per-launch secret the backend injects into index.html; guards the local socket from other pages. */
  sessionKey?: string;
  maxBackoffMs?: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void; method: string };

export class RealClient implements SessionClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<RequestId, Pending>();
  private ls = { notification: new Set<Function>(), serverRequest: new Set<Function>(), connection: new Set<Function>() };
  private attempt = 0;
  private closedByUser = false;
  private everOpened = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private opts: RealClientOptions = {}) {}

  backend = {
    listSkills: async (): Promise<Skill[]> => (await fetch('/api/skills', { headers: this.hdr() })).json(),
    history: async (threadId: string): Promise<Turn[]> => {
      const r = await fetch(`/api/threads/${encodeURIComponent(threadId)}/history`, { headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    meta: async (threadId: string): Promise<{ agents: unknown[]; usage: { used: number; window: number } | null }> => {
      const r = await fetch(`/api/threads/${encodeURIComponent(threadId)}/meta`, { headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    upload: async (file: Blob): Promise<{ path: string; url: string }> => {
      const r = await fetch('/api/uploads', { method: 'POST', headers: { ...this.hdr(), 'content-type': file.type }, body: file });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    activity: async (): Promise<Record<string, number>> => {
      const r = await fetch('/api/threads/activity', { headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    restoreTodos: async (threadId: string): Promise<Item[]> => {
      const r = await fetch(`/api/threads/${encodeURIComponent(threadId)}/restore-todos`, { method: 'POST', headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    extraModels: async (): Promise<Model[]> => {
      const r = await fetch('/api/models/extra', { headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    omoVersion: async (): Promise<OmoVersion> => {
      const r = await fetch('/api/omo/version', { headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
    omoUpdate: async (): Promise<OmoUpdateResult> => {
      const r = await fetch('/api/omo/update', { method: 'POST', headers: this.hdr() });
      if (!r.ok) throw new Error(await r.text());
      return r.json();
    },
  };
  private hdr() { return this.opts.sessionKey ? { 'x-mc-key': this.opts.sessionKey } : undefined; }

  on(ev: 'notification' | 'serverRequest' | 'connection', cb: any) { this.ls[ev].add(cb); return () => this.ls[ev].delete(cb); }
  private emit(ev: keyof RealClient['ls'], p: unknown) { this.ls[ev].forEach((f) => { try { (f as any)(p); } catch (e) { console.error(e); } }); }

  connect(): Promise<void> {
    this.closedByUser = false;
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }
  private open(onFirstOpen?: () => void, onFirstFail?: (e: unknown) => void) {
    const base = this.opts.url ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    const url = this.opts.sessionKey ? `${base}?key=${encodeURIComponent(this.opts.sessionKey)}` : base;
    this.emit('connection', { state: this.everOpened ? 'reconnecting' : 'connecting', attempt: this.attempt });
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = async () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.attempt = 0;
      try {
        await this.request('initialize', { clientInfo: { name: 'omo-mission-control', version: '0.1.0' }, capabilities: { experimentalApi: true } } satisfies InitializeParams);
        this.emit('connection', { state: 'open', reconnected });
        onFirstOpen?.();
      } catch (e) { onFirstFail?.(e); ws.close(); }
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = () => {
      for (const [, p] of this.pending) p.reject({ code: -32000, message: `연결이 끊겨 ${p.method} 요청이 취소되었습니다` });
      this.pending.clear();
      if (this.closedByUser) { this.emit('connection', { state: 'closed' }); return; }
      if (!this.everOpened && onFirstFail && this.attempt >= 2) { onFirstFail(new Error('backend unreachable')); }
      this.scheduleReconnect();
    };
  }
  private scheduleReconnect() {
    this.attempt++;
    const retryInMs = Math.min(this.opts.maxBackoffMs ?? 15000, 500 * 2 ** this.attempt);
    this.emit('connection', { state: 'reconnecting', attempt: this.attempt, retryInMs });
    this.timer = setTimeout(() => this.refreshKey().then(() => this.open()), retryInMs);
  }
  /** Skip the backoff wait (UI "지금 다시 연결"). */
  reconnectNow() { if (this.timer) { clearTimeout(this.timer); this.timer = null; this.refreshKey().then(() => this.open()); } }
  /** The backend issues a new session key on every start, so a reconnect after a restart asks for it again. */
  private async refreshKey() {
    if (!this.opts.sessionKey) return;
    try {
      const r = await fetch('/api/config', { cache: 'no-store' });
      const cfg = r.ok ? ((await r.json()) as { key?: string }) : null;
      if (cfg?.key) this.opts.sessionKey = cfg.key;
    } catch {}
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      'error' in msg ? p.reject(msg.error) : p.resolve(msg.result);
    } else if (hasId && typeof msg.method === 'string') {
      this.emit('serverRequest', msg);
    } else if (typeof msg.method === 'string') {
      this.emit('notification', msg);
    }
  }
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject({ code: -32000, message: 'app-server에 연결되어 있지 않습니다' });
    const id = ++this.seq;
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  respond(id: RequestId, result: unknown) { this.ws?.send(JSON.stringify({ id, result })); }
  close() { this.closedByUser = true; if (this.timer) clearTimeout(this.timer); this.ws?.close(); }
}
