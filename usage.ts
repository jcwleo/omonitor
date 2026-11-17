import { z } from 'zod';
import { UsageAuthError } from './usage-oauth.ts';
import type { UsageAuth } from './usage-auth.ts';
import type { UsageCredential } from './usage-oauth.ts';
import type { PlanUsage, UsageAccount, UsageProvider, UsageWindow } from './src/protocol.ts';

const claudeWindowSchema = z.object({ utilization: z.number(), resets_at: z.string().nullable() });
const claudeSchema = z.object({
  limits: z.array(z.object({
    kind: z.string(), percent: z.number(), resets_at: z.string().nullable(),
    scope: z.object({ model: z.object({ display_name: z.string().nullable() }).nullable().optional() }).nullable().optional(),
  })).optional(),
  five_hour: claudeWindowSchema.nullable().optional(), seven_day: claudeWindowSchema.nullable().optional(),
  seven_day_opus: claudeWindowSchema.nullable().optional(), seven_day_sonnet: claudeWindowSchema.nullable().optional(),
});
const gptWindowSchema = z.object({ limit_window_seconds: z.number(), used_percent: z.number(), reset_at: z.number().nullable().optional() });
const gptSchema = z.object({
  plan_type: z.string().optional(),
  rate_limit: z.object({ primary_window: gptWindowSchema.nullable().optional(), secondary_window: gptWindowSchema.nullable().optional() }),
});
const CACHE_MS = { claude: 180000, chatgpt: 30000 } as const;
class UsageError extends Error {
  constructor(readonly status: number) { super(`사용량을 읽지 못했습니다 (HTTP ${status})`); }
}
const pct = (n: number) => Math.max(0, Math.min(100, n));
const at = (s: string | null) => s ? Date.parse(s) || null : null;
const windowLabel = (s: number) => s === 604800 ? '주간' : s % 86400 === 0 ? `${s / 86400}일` : s % 3600 === 0 ? `${s / 3600}시간` : `${Math.round(s / 60)}분`;

async function usageGet(provider: UsageProvider, credential: UsageCredential): Promise<unknown> {
  const claude = provider === 'claude';
  const res = await fetch(claude ? 'https://api.anthropic.com/api/oauth/usage' : 'https://chatgpt.com/backend-api/wham/usage', {
    headers: {
      authorization: `Bearer ${credential.access}`, 'user-agent': 'omonitor/0.1.0', accept: 'application/json',
      ...(claude ? { 'anthropic-beta': 'oauth-2025-04-20' } : credential.accountId ? { 'chatgpt-account-id': credential.accountId } : {}),
    },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new UsageError(res.status);
  return res.json();
}
function claudeWindows(raw: unknown): UsageWindow[] {
  const u = claudeSchema.parse(raw);
  if (u.limits?.length) return u.limits.map(l => ({
    label: l.kind === 'session' ? '5시간' : l.kind === 'weekly_all' ? '주간' : l.scope?.model?.display_name ? `주간 ${l.scope.model.display_name}` : l.kind,
    percent: pct(l.percent), resetsAt: at(l.resets_at),
  }));
  return ([['five_hour', '5시간'], ['seven_day', '주간'], ['seven_day_opus', '주간 Opus'], ['seven_day_sonnet', '주간 Sonnet']] as const)
    .flatMap(([key, label]) => {
      const w = u[key];
      return w ? [{ label, percent: pct(w.utilization), resetsAt: at(w.resets_at) }] : [];
    });
}
async function accountUsage(provider: UsageProvider, auth: UsageAuth): Promise<UsageAccount> {
  const base = { provider, name: provider === 'claude' ? 'Claude' : 'ChatGPT', source: 'omonitor' } as const;
  try {
    const credential = await auth.credential(provider);
    if (!credential) return { ...base, plan: null, windows: [], errorCode: 'credentials', error: '설정의 구독 계정에서 로그인하세요' };
    let usedAccess = credential.access;
    let raw: unknown;
    try { raw = await usageGet(provider, credential); }
    catch (error) {
      if (!(error instanceof UsageError && error.status === 401)) throw error;
      const updated = await auth.credential(provider, true);
      if (!updated) throw new UsageAuthError('로그아웃됐습니다. 구독 계정에서 로그인하세요', 401);
      usedAccess = updated.access;
      raw = await usageGet(provider, updated);
    }
    if (auth.store.read(provider).credential?.access !== usedAccess) {
      throw new UsageAuthError('로그인 상태가 변경됐습니다. 사용량을 다시 확인하세요', 401);
    }
    let plan: string | null = null;
    let windows: UsageWindow[];
    if (provider === 'claude') windows = claudeWindows(raw);
    else {
      const u = gptSchema.parse(raw);
      plan = u.plan_type ?? null;
      windows = [u.rate_limit.primary_window, u.rate_limit.secondary_window].flatMap(w => w ? [{
        label: windowLabel(w.limit_window_seconds), percent: pct(w.used_percent), resetsAt: w.reset_at ? w.reset_at * 1000 : null,
      }] : []);
    }
    if (!windows.length) return { ...base, plan, windows, errorCode: 'unavailable', error: '사용량 응답에 제한 정보가 없습니다' };
    return { ...base, plan, windows };
  } catch (error) {
    const authentication = (error instanceof UsageAuthError || error instanceof UsageError) && [400, 401, 403].includes(error.status);
    return {
      ...base, plan: null, windows: [], errorCode: authentication ? 'authentication' : 'unavailable',
      error: error instanceof UsageAuthError ? error.message : authentication ? '사용량 조회 인증이 거절됐습니다. 구독 계정에서 다시 로그인하세요'
        : error instanceof UsageError ? error.message : '사용량을 읽지 못했습니다. 잠시 후 다시 확인하세요',
    };
  }
}
export function createPlanUsage(auth: UsageAuth): () => Promise<PlanUsage> {
  const cache = new Map<UsageProvider, { revision: number; at: number; data: Promise<UsageAccount> }>();
  async function cached(provider: UsageProvider): Promise<UsageAccount> {
    const revision = auth.store.read(provider).revision;
    const hit = cache.get(provider);
    if (hit?.revision === revision && Date.now() - hit.at < CACHE_MS[provider]) return hit.data;
    const entry = { revision, at: Date.now(), data: accountUsage(provider, auth) };
    cache.set(provider, entry);
    const result = await entry.data;
    if (auth.store.read(provider).revision !== revision && cache.get(provider) === entry) cache.delete(provider);
    return result;
  }
  return async () => ({ checkedAt: Date.now(), accounts: await Promise.all([cached('claude'), cached('chatgpt')]) });
}
