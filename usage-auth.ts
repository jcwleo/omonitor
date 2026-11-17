import { z } from 'zod';
import { UsageAuthStore } from './usage-auth-store.ts';
import { authorization, authorizationCode, exchange, providerSchema, renew, UsageAuthError } from './usage-oauth.ts';
import type { UsageCredential } from './usage-oauth.ts';
import type { UsageAuthState, UsageLogin, UsageProvider } from './src/protocol.ts';

type Flow = {
  view: UsageLogin; verifier: string; state: string; revision: number;
  timer: ReturnType<typeof setTimeout>; listener?: ReturnType<typeof Bun.serve>;
};
const completionSchema = z.object({ id: z.string().min(1), input: z.string().trim().min(1).max(16384) });
const cancelSchema = z.object({ id: z.string().min(1) });
const publicError = (error: unknown) => error instanceof UsageAuthError ? error.message : '인증 서버에 연결하지 못했습니다. 다시 시도하세요';

export class UsageAuth {
  private readonly flows = new Map<UsageProvider, Flow>();
  private readonly refreshing = new Map<UsageProvider, Promise<UsageCredential>>();
  constructor(readonly store: UsageAuthStore) {}
  state(): UsageAuthState {
    return {
      accounts: providerSchema.options.map(provider => {
        const { credential } = this.store.read(provider);
        return { provider, connected: !!credential, email: credential?.email ?? null, expiresAt: credential?.expires ?? null };
      }),
      pending: [...this.flows.values()].map(flow => ({ ...flow.view })),
    };
  }
  private stop(flow: Flow) {
    clearTimeout(flow.timer);
    flow.listener?.stop();
  }
  cancel(provider: UsageProvider, id: string) {
    const flow = this.flows.get(provider);
    if (!flow || flow.view.id !== id) throw new UsageAuthError('로그인 요청을 찾지 못했습니다', 404);
    this.stop(flow);
    this.flows.delete(provider);
  }
  start(provider: UsageProvider): UsageLogin {
    const previous = this.flows.get(provider);
    if (previous) this.cancel(provider, previous.view.id);
    const auth = authorization(provider);
    const view: UsageLogin = {
      provider, id: crypto.randomUUID(), url: auth.url, expiresAt: Date.now() + 600000,
      mode: 'paste', status: 'pending',
    };
    const flow: Flow = {
      view, verifier: auth.verifier, state: auth.state, revision: this.store.read(provider).revision,
      timer: setTimeout(() => {
        flow.view.status = 'error';
        flow.view.error = '로그인 요청이 만료됐습니다. 다시 로그인하세요';
        this.stop(flow);
      }, 600000),
    };
    flow.timer.unref();
    this.flows.set(provider, flow);
    if (provider === 'chatgpt') {
      try {
        flow.listener = Bun.serve({
          hostname: '127.0.0.1', port: 1455,
          fetch: async request => {
            const url = new URL(request.url);
            if (request.method !== 'GET' || url.pathname !== '/auth/callback') return new Response('Not found', { status: 404 });
            if (!['localhost:1455', '127.0.0.1:1455'].includes(url.host)) return new Response('Forbidden', { status: 403 });
            const headers = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
            if (url.searchParams.has('error') && url.searchParams.get('state') === flow.state) {
              flow.view.status = 'error';
              flow.view.error = 'ChatGPT 로그인이 취소됐습니다. 다시 로그인하세요';
              this.stop(flow);
              return new Response(flow.view.error, { status: 400, headers });
            }
            try {
              await this.complete(provider, view.id, `http://localhost:1455/auth/callback${url.search}`);
              return new Response('ChatGPT 로그인이 완료됐습니다. 이 탭을 닫고 omonitor로 돌아가세요.', { headers });
            } catch (error) {
              return new Response(publicError(error), { status: error instanceof UsageAuthError ? error.status : 502, headers });
            }
          },
        });
        view.mode = 'callback';
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EADDRINUSE')) {
          this.cancel(provider, view.id);
          throw error;
        }
      }
    }
    return { ...view };
  }
  async complete(provider: UsageProvider, id: string, input: string) {
    const flow = this.flows.get(provider);
    if (!flow || flow.view.id !== id || flow.view.expiresAt <= Date.now()) throw new UsageAuthError('로그인 요청이 만료됐습니다. 다시 로그인하세요');
    if (flow.view.status !== 'pending') throw new UsageAuthError('이미 처리된 로그인 요청입니다', 409);
    const code = authorizationCode(provider, input, flow.state);
    const lease = this.store.claim(provider, flow.revision);
    flow.view.status = 'exchanging';
    try {
      const credential = await exchange(provider, { code, verifier: flow.verifier, state: flow.state });
      if (this.flows.get(provider) !== flow || flow.view.expiresAt <= Date.now()) throw new UsageAuthError('로그인 요청이 취소됐습니다', 409);
      this.store.save(provider, lease, credential);
      flow.view.status = 'complete';
    } catch (error) {
      flow.view.status = 'error';
      flow.view.error = publicError(error);
      throw new UsageAuthError(flow.view.error, error instanceof UsageAuthError ? error.status : 502);
    } finally {
      this.store.release(provider, lease);
      this.stop(flow);
    }
  }
  logout(provider: UsageProvider) {
    const flow = this.flows.get(provider);
    if (flow) this.cancel(provider, flow.view.id);
    this.store.logout(provider);
  }
  async credential(provider: UsageProvider, force = false): Promise<UsageCredential | null> {
    const active = this.refreshing.get(provider);
    if (active) return active;
    const snapshot = this.store.read(provider);
    const credential = snapshot.credential;
    if (!credential) return null;
    if (!force && credential.expires > Date.now() + 60000) return credential;
    const lease = this.store.claim(provider, snapshot.revision);
    const refreshing = (async () => {
      try {
        const updated = await renew(provider, credential);
        this.store.save(provider, lease, updated);
        return updated;
      } finally {
        this.store.release(provider, lease);
        this.refreshing.delete(provider);
      }
    })();
    this.refreshing.set(provider, refreshing);
    return refreshing;
  }
  async http(request: Request, url: URL) {
    const headers = { 'cache-control': 'no-store' };
    try {
      if (url.pathname === '/api/usage/auth' && request.method === 'GET') return Response.json(this.state(), { headers });
      const match = url.pathname.match(/^\/api\/usage\/auth\/(claude|chatgpt)\/(start|complete|cancel|logout)$/);
      if (!match || request.method !== 'POST') return new Response('Not found', { status: 404, headers });
      const provider = providerSchema.parse(match[1]);
      switch (match[2]) {
        case 'start': return Response.json(this.start(provider), { headers });
        case 'complete': {
          const body = completionSchema.parse(await request.json());
          await this.complete(provider, body.id, body.input);
          break;
        }
        case 'cancel': this.cancel(provider, cancelSchema.parse(await request.json()).id); break;
        case 'logout': this.logout(provider); break;
      }
      return Response.json({ ok: true }, { headers });
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) return new Response('로그인 요청 형식이 올바르지 않습니다', { status: 400, headers });
      return new Response(publicError(error), { status: error instanceof UsageAuthError ? error.status : 502, headers });
    }
  }
  close() {
    for (const flow of this.flows.values()) this.stop(flow);
    this.flows.clear();
    this.store.close();
  }
}
