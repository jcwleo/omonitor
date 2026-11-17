import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { UsageProvider } from './src/protocol.ts';

export const providerSchema = z.enum(['claude', 'chatgpt']);
export const credentialSchema = z.object({
  access: z.string().min(1), refresh: z.string().min(1), expires: z.number().finite(),
  email: z.string().nullable(), accountId: z.string().nullable(),
});
export type UsageCredential = z.infer<typeof credentialSchema>;
export class UsageAuthError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const config = {
  chatgpt: {
    client: 'app_EMoamEEZ73f0CkXaXp7hrann',
    authorize: 'https://auth.openai.com/oauth/authorize',
    token: 'https://auth.openai.com/oauth/token',
    redirect: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
  },
  claude: {
    client: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorize: 'https://claude.ai/oauth/authorize',
    token: 'https://platform.claude.com/v1/oauth/token',
    redirect: 'https://console.anthropic.com/oauth/code/callback',
    scope: 'user:profile user:inference',
  },
} as const;
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(), id_token: z.string().optional(),
  account: z.object({ email_address: z.string().optional() }).optional(),
});
const claimsSchema = z.object({
  email: z.string().optional(),
  'https://api.openai.com/profile': z.object({ email: z.string().optional() }).optional(),
  'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().optional() }).optional(),
});
function claims(token: string | undefined) {
  const payload = token?.split('.')[1];
  if (!payload) return {};
  try {
    return claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) return {};
    throw error;
  }
}
export function authorization(provider: UsageProvider) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(32).toString('base64url');
  const c = config[provider];
  const url = new URL(c.authorize);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: c.client, redirect_uri: c.redirect, scope: c.scope,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', state,
    ...(provider === 'claude' ? { code: 'true' } : {
      id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'omonitor',
    }),
  }).toString();
  return { verifier, state, url: url.href };
}
export function authorizationCode(provider: UsageProvider, input: string, state: string) {
  let code: string | null = null;
  let returnedState: string | null = null;
  if (provider === 'chatgpt') {
    let url: URL;
    try { url = new URL(input.trim()); }
    catch (error) {
      if (error instanceof TypeError) throw new UsageAuthError('로그인 후 이동한 주소 전체를 붙여넣으세요');
      throw error;
    }
    if (url.origin !== new URL(config.chatgpt.redirect).origin || url.pathname !== '/auth/callback') {
      throw new UsageAuthError('ChatGPT 로그인 콜백 주소가 아닙니다');
    }
    code = url.searchParams.get('code');
    returnedState = url.searchParams.get('state');
    if (url.searchParams.has('error') && returnedState === state) throw new UsageAuthError('ChatGPT 로그인이 취소됐습니다');
  } else {
    [code = null, returnedState = null] = input.trim().split('#');
  }
  if (!code || returnedState !== state) throw new UsageAuthError('승인 코드가 이 로그인 요청과 일치하지 않습니다. 다시 로그인하세요');
  return code;
}
async function tokenRequest(provider: UsageProvider, fields: Record<string, string>) {
  const c = config[provider];
  const body = { ...fields, client_id: c.client };
  const response = await fetch(c.token, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': provider === 'chatgpt' ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: provider === 'chatgpt' ? new URLSearchParams(body) : JSON.stringify(body),
  });
  if (!response.ok) throw new UsageAuthError(
    `인증 ${fields.grant_type === 'refresh_token' ? '갱신' : '교환'}에 실패했습니다 (HTTP ${response.status}). 구독 계정에서 다시 로그인하세요`,
    response.status === 400 || response.status === 401 ? 401 : 502,
  );
  const parsed = tokenSchema.safeParse(await response.json());
  if (!parsed.success) throw new UsageAuthError('인증 서버 응답 형식을 읽지 못했습니다', 502);
  return parsed.data;
}
function credential(token: z.infer<typeof tokenSchema>, previous?: UsageCredential): UsageCredential {
  const accessClaims = claims(token.access_token);
  const idClaims = claims(token.id_token);
  const refresh = token.refresh_token ?? previous?.refresh;
  if (!refresh) throw new UsageAuthError('인증 서버가 갱신 토큰을 반환하지 않았습니다', 502);
  return {
    access: token.access_token, refresh, expires: Date.now() + token.expires_in * 1000,
    email: token.account?.email_address ?? idClaims.email ?? accessClaims['https://api.openai.com/profile']?.email ?? previous?.email ?? null,
    accountId: idClaims['https://api.openai.com/auth']?.chatgpt_account_id ?? accessClaims['https://api.openai.com/auth']?.chatgpt_account_id ?? previous?.accountId ?? null,
  };
}
export async function exchange(provider: UsageProvider, flow: { code: string; verifier: string; state: string }) {
  return credential(await tokenRequest(provider, {
    grant_type: 'authorization_code', code: flow.code, code_verifier: flow.verifier,
    redirect_uri: config[provider].redirect, ...(provider === 'claude' ? { state: flow.state } : {}),
  }));
}
export async function renew(provider: UsageProvider, previous: UsageCredential) {
  return credential(await tokenRequest(provider, { grant_type: 'refresh_token', refresh_token: previous.refresh }), previous);
}
