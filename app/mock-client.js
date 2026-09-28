// MockClient — an in-memory fake of `omo app-server` implementing the SessionClient contract
// (connect / close / request / respond / on). Same message shapes as the real server.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const M = 60000, H = 3600000, D = 86400000;
let n = 0;
const nid = (p) => `${p}_${(++n).toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const txt = (t) => [{ type: 'text', text: t }];

const user = (t) => ({ type: 'userMessage', id: nid('it'), content: txt(t) });
const agent = (t) => ({ type: 'agentMessage', id: nid('it'), text: t });
const think = (...s) => ({ type: 'reasoning', id: nid('it'), summary: s, content: [] });
const cmd = (command, cwd, out, exitCode = 0, durationMs = 1400) => ({ type: 'commandExecution', id: nid('it'), command, cwd, status: exitCode === 0 ? 'completed' : 'failed', exitCode, aggregatedOutput: out, durationMs });
const fc = (path, diff, kind = 'update') => ({ type: 'fileChange', id: nid('it'), status: 'completed', changes: [{ path, kind, diff }] });
const dyn = (tool, args, result, success = true) => ({ type: 'dynamicToolCall', id: nid('it'), tool, arguments: args, status: 'completed', success, contentItems: [{ type: 'inputText', text: result }] });
const todo = (args) => dyn('todo', args, 'ok');
const mcp = (server, tool, args, result) => ({ type: 'mcpToolCall', id: nid('it'), server, tool, arguments: args, status: 'completed', result: { content: [{ type: 'text', text: result }] } });

const PAY = '/Users/me/work/payments-api';
const SKILLS = [
  ...[['goal', '세션 목표 설정·조회·일시정지·해제'], ['ulw-execute', 'Prometheus 계획으로 Atlas 실행 시작'], ['refactor', 'LSP·AST-grep 기반 리팩터링 + TDD 검증'], ['handoff', '새 세션으로 넘길 인계 요약 작성'], ['stop-continuation', 'todo 이어가기·목표 등 자동 진행 모두 중단'], ['remove-ai-slops', '브랜치 변경에서 AI 티 나는 코드 정리'], ['hyperplan', '팀 모드 적대적 계획 (team_mode 필요)']].map(([name, desc]) => ({ kind: 'command', name, desc, source: 'builtin' })),
  ...[['git-master', '원자적 커밋 · 리베이스 · 이력 추적'], ['review-work', '구현 후 실제 화면 QA + 게이트 리뷰'], ['ulw-research', '출처 인용이 필요한 최대 포화 리서치'], ['frontend', 'UI/UX 구현 · 스타일링'], ['playwright', '브라우저 자동화 · 스크린샷 검증'], ['debugging', '재현 → 원인 추적 → 수정 검증'], ['security-review', '변경 사항 보안 검토'], ['init-deep', '폴더별 AGENTS.md 계층 생성']].map(([name, desc]) => ({ kind: 'skill', name, desc, source: 'builtin' })),
  { kind: 'skill', name: 'payments-runbook', desc: '결제 장애 대응 절차 (사용자 스킬 · .claude/skills)', source: 'user' },
  { kind: 'skill', name: 'korean-copy', desc: '한국어 UI 카피 톤 가이드 (사용자 스킬 · ~/.omo/skills)', source: 'user' },
  { kind: 'keyword', name: 'ulw', insert: 'ulw ', label: 'ultrawork · ulw', desc: '어려운 작업: 코드 파악 → 계획 → 단계별 검증', source: 'builtin' },
  { kind: 'keyword', name: 'mass ulw', insert: 'mass ulw ', label: 'mass ulw', desc: '작업을 에이전트 그래프로 나눠 병렬 실행', source: 'builtin' },
];
const PAY_PLAN = [
  { phase: '조사', items: ['기존 PaymentService 호출부 파악', '게이트웨이별 차이점 정리', '테스트 커버리지 확인'] },
  { phase: '구현', items: ['PaymentAdapter 인터페이스 정의', 'TossAdapter 구현', 'StripeAdapter 구현', 'PaymentService 의존성 주입으로 교체'] },
  { phase: '검증', items: ['단위 테스트 추가', '통합 테스트 실행'] },
];
const DIFF_IFACE = `diff --git a/src/payments/adapter.ts b/src/payments/adapter.ts
new file mode 100644
--- /dev/null
+++ b/src/payments/adapter.ts
@@ -0,0 +1,12 @@
+export interface PaymentAdapter {
+  readonly gateway: 'toss' | 'stripe'
+  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>
+  capture(paymentId: string, amount: Money): Promise<CaptureResult>
+  refund(paymentId: string, amount?: Money): Promise<RefundResult>
+}
+
+export type Money = { currency: 'KRW' | 'USD'; value: number }
+export interface AuthorizeRequest { orderId: string; amount: Money; idempotencyKey: string }
+export interface AuthorizeResult { paymentId: string; status: 'authorized' | 'declined' }
+export interface CaptureResult { status: 'captured' | 'failed' }
+export interface RefundResult { status: 'refunded' | 'failed' }`;
const DIFF_TOSS = `diff --git a/src/payments/toss.ts b/src/payments/toss.ts
--- a/src/payments/toss.ts
+++ b/src/payments/toss.ts
@@ -1,9 +1,14 @@
-import { PaymentService } from './service'
+import type { PaymentAdapter, AuthorizeRequest } from './adapter'
 
-export async function payWithToss(orderId: string, amount: number) {
-  const res = await PaymentService.call('toss', { orderId, amount })
-  return res.data
+export class TossAdapter implements PaymentAdapter {
+  readonly gateway = 'toss' as const
+  constructor(private http: HttpClient, private secret: string) {}
+
+  async authorize(req: AuthorizeRequest) {
+    const res = await this.http.post('/v1/payments/confirm', toTossBody(req))
+    return { paymentId: res.paymentKey, status: mapStatus(res.status) }
+  }
 }`;
const DIFF_STRIPE = `diff --git a/src/payments/stripe.ts b/src/payments/stripe.ts
new file mode 100644
--- /dev/null
+++ b/src/payments/stripe.ts
@@ -0,0 +1,16 @@
+import Stripe from 'stripe'
+import type { PaymentAdapter, AuthorizeRequest } from './adapter'
+
+export class StripeAdapter implements PaymentAdapter {
+  readonly gateway = 'stripe' as const
+  constructor(private stripe: Stripe) {}
+
+  async authorize(req: AuthorizeRequest) {
+    const intent = await this.stripe.paymentIntents.create(
+      { amount: req.amount.value, currency: req.amount.currency.toLowerCase(), capture_method: 'manual' },
+      { idempotencyKey: req.idempotencyKey },
+    )
+    return { paymentId: intent.id, status: intent.status === 'requires_capture' ? 'authorized' : 'declined' }
+  }
+}`;
const DIFF_SERVICE = `diff --git a/src/payments/service.ts b/src/payments/service.ts
--- a/src/payments/service.ts
+++ b/src/payments/service.ts
@@ -3,18 +3,11 @@
-export class PaymentService {
-  static async call(gateway: string, body: unknown) {
-    if (gateway === 'toss') return tossClient.post('/confirm', body)
-    if (gateway === 'stripe') return stripeClient.charge(body)
-    throw new Error('unknown gateway')
-  }
-}
+export class PaymentService {
+  constructor(private adapters: Record<Gateway, PaymentAdapter>) {}
+
+  authorize(gateway: Gateway, req: AuthorizeRequest) {
+    return this.adapters[gateway].authorize(req)
+  }
+}`;
const DIFF_CI = `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -8,20 +8,12 @@ jobs:
   test:
     runs-on: ubuntu-latest
     steps:
       - uses: actions/checkout@v4
-      - uses: actions/setup-node@v4
-        with:
-          node-version: 20
-      - run: npm ci
-      - run: npm run lint
-      - run: npm test
+      - uses: oven-sh/setup-bun@v2
+      - run: bun install --frozen-lockfile
+      - run: bun run check
-  lint:
-    runs-on: ubuntu-latest
-    steps:
-      - uses: actions/checkout@v4
-      - run: npm ci && npm run lint`;
const DIFF_COPY = `diff --git a/src/onboarding/copy.ko.json b/src/onboarding/copy.ko.json
--- a/src/onboarding/copy.ko.json
+++ b/src/onboarding/copy.ko.json
@@ -1,6 +1,6 @@
 {
-  "welcome.title": "환영합니다! 서비스를 시작하시겠습니까?",
+  "welcome.title": "시작해 볼까요?",
-  "permission.body": "원활한 서비스 이용을 위하여 알림 권한을 허용하여 주십시오.",
+  "permission.body": "중요한 소식만 알려 드릴게요.",
   "done.cta": "완료"
 }`;

function longTestOutput() {
  const files = ['adapter', 'toss', 'stripe', 'service', 'refund', 'capture', 'webhook', 'idempotency'];
  const out = ['bun test v1.2.21', ''];
  let i = 0;
  for (const f of files) {
    out.push(`src/payments/__tests__/${f}.test.ts:`);
    for (let k = 0; k < 78; k++) { i++; out.push(`✓ ${f} › case ${String(k + 1).padStart(2, '0')} ${['authorizes', 'captures', 'refunds', 'rejects invalid amount', 'retries on 429', 'keeps idempotency'][k % 6]} [${(Math.random() * 9 + 0.4).toFixed(2)}ms]`); }
    out.push('');
  }
  out.push(` ${i} pass`, ' 0 fail', ` ${i * 3} expect() calls`, `Ran ${i} tests across ${files.length} files. [2.41s]`);
  return out.join('\n');
}

function seed(now) {
  const T = (ms) => now - ms;
  const threads = new Map();
  const add = (t) => threads.set(t.id, t);
  const base = (o) => ({ preview: '', source: 'appServer', path: `~/.omo/sessions/${o.id}.jsonl`, archived: false, loaded: true, hidden: false, goal: null, tasks: null, settings: { model: 'claude-opus-5', effort: 'high' }, turns: [], ...o });

  // 1. todo 5/9 + 3 subagents, actively working
  const pay1 = [
    user('결제 모듈을 게이트웨이별 어댑터로 분리해줘. 기존 테스트는 전부 통과해야 해. ulw'),
    think('PaymentService가 toss/stripe 분기를 직접 들고 있다.', '어댑터 인터페이스를 먼저 정의하고 게이트웨이별 구현을 옮기는 순서가 안전하다.'),
    todo({ op: 'init', list: PAY_PLAN }),
    cmd('rg -n "PaymentService" src --stats', PAY, 'src/checkout/confirm.ts:14:  const res = await PaymentService.call(gateway, body)\nsrc/payments/toss.ts:1:import { PaymentService } from \'./service\'\nsrc/payments/stripe-legacy.ts:3:import { PaymentService } from \'./service\'\nsrc/subscriptions/renew.ts:41:    await PaymentService.call(\'stripe\', payload)\n\n4 matches\n4 matched lines\n4 files contained matches', 0, 380),
    todo({ op: 'done', task: '기존 PaymentService 호출부 파악' }),
    todo({ op: 'done', task: '게이트웨이별 차이점 정리' }),
    cmd('bun test --coverage src/payments', PAY, 'src/payments/__tests__/service.test.ts:\n✓ PaymentService › toss confirm [3.12ms]\n✓ PaymentService › stripe charge [2.87ms]\n\n 2 pass\n 0 fail\n---------------------|---------|---------|\nFile                 | % Funcs | % Lines |\n---------------------|---------|---------|\nsrc/payments/service |   66.67 |   58.33 |\n---------------------|---------|---------|', 0, 2100),
    todo({ op: 'done', task: '테스트 커버리지 확인' }),
    fc('src/payments/adapter.ts', DIFF_IFACE, 'add'),
    todo({ op: 'done', task: 'PaymentAdapter 인터페이스 정의' }),
    fc('src/payments/toss.ts', DIFF_TOSS),
    todo({ op: 'done', task: 'TossAdapter 구현' }),
    agent('**TossAdapter**까지 옮겼습니다. 다음은 `StripeAdapter`입니다.\n\n- `PaymentAdapter` 인터페이스: `authorize` / `capture` / `refund`\n- Toss는 `paymentKey`를 `paymentId`로 매핑\n\nStripe 쪽은 idempotency key 처리 방식을 librarian에게 확인시키고 있습니다.'),
  ];
  add(base({ id: 'th_pay', name: '결제 모듈 리팩터링', cwd: PAY, preview: '결제 모듈을 게이트웨이별 어댑터로 분리해줘…', status: { type: 'active', activeFlags: [] }, createdAt: T(47 * M), updatedAt: T(6000),
    goal: { objective: 'PaymentService를 게이트웨이별 어댑터로 분리하고 기존 테스트 100% 통과 유지', status: 'active', tokenBudget: 2000000, tokensUsed: 1240000 },
    turns: [{ id: 'tu_pay1', status: 'inProgress', startedAt: T(47 * M), items: pay1 }],
    tasks: [
      { task_id: 'bg_7f2a', name: 'Stripe SDK 사용처 탐색', task_summary: 'stripe.* 호출부와 버전별 차이 수집', agent_type: 'explore', category: 'quick', model: 'gpt-5.6-luna-fast', live_progress: { activity: 'grep 결과 정리 중', started_at: T(4 * M), current_tool: 'grep' }, run_stats: { tool_calls: 14, tokens: 38200 } },
      { task_id: 'bg_7f2b', name: 'PaymentIntent 문서 조사', task_summary: 'manual capture + idempotency 규칙 확인', agent_type: 'librarian', category: 'research', model: 'gpt-5.6-luna-fast', run_stats: { tool_calls: 9, tokens: 61000, duration_ms: 142000 }, final_response: 'PaymentIntent 생성 시 capture_method=manual을 쓰면 7일 내 capture해야 합니다. idempotencyKey는 요청 옵션으로 넘기며 24시간 유지됩니다.' },
      { task_id: 'bg_7f2c', name: '어댑터 경계 설계 리뷰', task_summary: '환불·부분취소가 인터페이스에 맞는지 검토', agent_type: 'oracle', category: 'ultrabrain', model: 'gpt-5.6-sol', child_session_id: 'th_oracle', live_progress: { activity: '설계안 검토', started_at: T(2 * M), current_tool: 'read' }, run_stats: { tool_calls: 3 } },
    ] }));
  add(base({ id: 'th_oracle', hidden: true, parentId: 'th_pay', name: 'oracle · 어댑터 경계 설계 리뷰', cwd: PAY, status: { type: 'active', activeFlags: [] }, createdAt: T(2 * M), updatedAt: T(8000), settings: { model: 'gpt-5.6-sol', effort: 'high' },
    turns: [{ id: 'tu_or1', status: 'inProgress', startedAt: T(2 * M), items: [user('PaymentAdapter 설계안을 리뷰해 줘. 환불/부분취소가 인터페이스에 맞는지 확인할 것.'), think('refund(paymentId, amount?)는 부분 환불을 표현할 수 있다.', '부분 capture는 Stripe에만 있으므로 선택 기능으로 분리할지 판단 필요.'), dyn('read', { path: 'src/payments/adapter.ts' }, '12 lines')] }] }));

  // 2. waiting on command approval
  add(base({ id: 'th_ci', name: 'CI 파이프라인 정리', cwd: '/Users/me/work/infra', preview: 'CI를 bun으로 바꾸고 lint 잡을 합쳐줘', status: { type: 'active', activeFlags: ['waitingOnApproval'] }, createdAt: T(22 * M), updatedAt: T(90000), settings: { model: 'claude-sonnet-5', effort: 'medium' },
    turns: [{ id: 'tu_ci1', status: 'inProgress', startedAt: T(22 * M), items: [
      user('CI를 bun으로 바꾸고 lint 잡을 test 잡에 합쳐줘. 정리한 커밋은 chore/ci-cleanup에 올려.'),
      todo({ op: 'init', list: [{ phase: '작업', items: ['워크플로 현황 파악', 'bun으로 전환', 'lint 잡 통합', '브랜치에 푸시'] }] }),
      cmd('gh workflow list', '/Users/me/work/infra', 'ci        active  48211093\nrelease   active  48211107\nnightly   active  51902214', 0, 820),
      todo({ op: 'done', task: '워크플로 현황 파악' }),
      fc('.github/workflows/ci.yml', DIFF_CI),
      todo({ op: 'done', task: 'bun으로 전환' }),
      todo({ op: 'done', task: 'lint 잡 통합' }),
      cmd('git rebase -i --autosquash origin/main', '/Users/me/work/infra', 'Successfully rebased and updated refs/heads/chore/ci-cleanup.', 0, 1900),
    ] }] }));

  // 3. waiting on 2 multiple-choice questions
  add(base({ id: 'th_copy', name: '온보딩 화면 카피', cwd: '/Users/me/work/web-app', preview: '온보딩 카피를 더 자연스럽게 다듬어줘', status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, createdAt: T(9 * M), updatedAt: T(40000), settings: { model: 'claude-sonnet-5', effort: 'low' },
    turns: [{ id: 'tu_copy1', status: 'inProgress', startedAt: T(9 * M), items: [
      user('온보딩 카피를 더 자연스럽게 다듬어줘. 번역투 같은 문장이 많아.'),
      cmd('rg -c "" src/onboarding/copy.ko.json', '/Users/me/work/web-app', '38', 0, 120),
      think('번역투 표현이 12곳. 톤을 정하지 않으면 전체를 두 번 고쳐야 한다.'),
      agent('카피 38줄 중 번역투로 보이는 문장이 **12곳** 있습니다. 톤과 범위를 먼저 정해 주세요.'),
    ] }] }));

  // 4. idle — app-server restarted, only user messages survived
  add(base({ id: 'th_docs', name: '문서 사이트 빌드', cwd: '/Users/me/work/docs', preview: '사이드바 정렬을 frontmatter order 기준으로', status: { type: 'idle' }, createdAt: T(5 * H), updatedAt: T(2 * H), settings: { model: 'claude-sonnet-5', effort: 'medium' },
    goal: { objective: '문서 사이트 빌드 시간을 60초 이하로', status: 'paused', tokenBudget: 500000, tokensUsed: 212000 },
    turns: [
      { id: 'tu_d1', status: 'completed', startedAt: T(5 * H), completedAt: T(4.6 * H), items: [user('빌드가 3분 넘게 걸려. 원인 찾아서 줄여줘.')] },
      { id: 'tu_d2', status: 'completed', startedAt: T(2.4 * H), completedAt: T(2 * H), items: [user('사이드바 정렬을 frontmatter order 기준으로 바꿔줘.')] },
    ] }));

  // 5. stopped with an error
  add(base({ id: 'th_mig', name: '마이그레이션 스크립트', cwd: PAY, preview: 'orders 테이블 파티셔닝 마이그레이션 작성', status: { type: 'systemError' }, createdAt: T(80 * M), updatedAt: T(14 * M), lastError: '모델 제공자 응답 시간 초과 — 3회 재시도 후 중단했습니다.', settings: { model: 'gpt-5.6-sol', effort: 'high' },
    turns: [{ id: 'tu_m1', status: 'failed', startedAt: T(80 * M), completedAt: T(14 * M), error: { message: '모델 제공자 응답 시간 초과 — 3회 재시도 후 중단했습니다.' }, items: [
      user('orders 테이블을 월 단위로 파티셔닝하는 마이그레이션 작성해줘. dry-run까지.'),
      todo({ op: 'init', list: [{ phase: '작성', items: ['스키마 확인', '마이그레이션 작성'] }, { phase: '검증', items: ['dry-run', '롤백 스크립트', '리뷰 요청'] }] }),
      todo({ op: 'done', task: '스키마 확인' }),
      fc('migrations/0042_partition_orders.sql', `--- /dev/null\n+++ b/migrations/0042_partition_orders.sql\n@@ -0,0 +1,6 @@\n+CREATE TABLE orders_p (LIKE orders INCLUDING ALL)\n+  PARTITION BY RANGE (created_at);\n+\n+CREATE TABLE orders_2026_09 PARTITION OF orders_p\n+  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');\n+-- TODO: backfill`, 'add'),
      todo({ op: 'done', task: '마이그레이션 작성' }),
      cmd('bun run migrate:dry 0042', PAY, '▶ dry-run 0042_partition_orders\n  ✓ CREATE TABLE orders_p\n  ✗ CREATE TABLE orders_2026_09\n    error: no partition of relation "orders_p" found for row\n    DETAIL: Partition key of the failing row contains (created_at) = (2025-12-31 23:59:59+09).\n\n1 statement failed. Rolled back.', 1, 3400),
    ] }] }));

  // 6. terminal session (cli + notLoaded)
  add(base({ id: 'th_term', name: 'omo-dashboard 스캐폴딩', cwd: '/Users/me/work/omo-dashboard', preview: 'Bun 서버에 /ws 라우팅 추가해줘', source: 'cli', loaded: false, status: { type: 'notLoaded' }, createdAt: T(35 * M), updatedAt: T(3 * M),
    turns: [{ id: 'tu_t1', status: 'completed', startedAt: T(35 * M), completedAt: T(3 * M), items: [user('Bun 서버에 /ws 라우팅 추가해줘'), agent('`/ws` 업그레이드 핸들러를 추가했습니다. 토큰은 `~/.omo/agent/app-server/ws-token`에서 읽습니다.')] }] }));

  // 7. archived
  add(base({ id: 'th_arch', name: '로그 파서 프로토타입', cwd: '/Users/me/work/log-parser', preview: 'nginx 로그를 파싱해서 p95 레이턴시 뽑기', archived: true, loaded: false, status: { type: 'notLoaded' }, createdAt: T(4 * D), updatedAt: T(3 * D),
    turns: [{ id: 'tu_a1', status: 'completed', startedAt: T(4 * D), completedAt: T(3 * D), items: [user('nginx 로그를 파싱해서 p95 레이턴시 뽑아줘'), agent('`parse.ts`로 p95를 계산합니다. 샘플 로그 기준 **p95 = 184ms**.')] }] }));

  return threads;
}

export class MockClient {
  constructor(opts = {}) {
    this.speed = opts.speed ?? 1;
    this.ls = { notification: new Set(), serverRequest: new Set(), connection: new Set() };
    this.connState = 'closed';
    this.subs = new Set();
    this.pending = new Map();
    this.runners = new Map();
    this.reqSeq = 700;
    this.started = new Set();
    this.threads = seed(Date.now());
    this.models = [
      { id: 'claude-opus-5', displayName: 'Claude Opus 5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5', supportedReasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'kimi-k3', displayName: 'Kimi K3', supportedReasoningEfforts: ['low', 'medium', 'max'] },
    ];
    this.seedRequests();
    this.backend = {
      listSkills: async () => { await sleep(200); return SKILLS; },
      restoreTodos: async (threadId) => {
        await sleep(700);
        if (threadId !== 'th_docs') return [];
        return [
          { type: 'dynamicToolCall', id: nid('it'), tool: 'todo', status: 'completed', success: true, contentItems: [], arguments: { op: 'init', list: [{ phase: '원인', items: ['빌드 프로파일링', '느린 플러그인 찾기'] }, { phase: '개선', items: ['이미지 최적화 캐시', '사이드바 정렬 변경'] }] } },
          { type: 'dynamicToolCall', id: nid('it'), tool: 'todo', status: 'completed', success: true, contentItems: [], arguments: { op: 'done', task: '빌드 프로파일링' } },
          { type: 'dynamicToolCall', id: nid('it'), tool: 'todo', status: 'completed', success: true, contentItems: [], arguments: { op: 'done', task: '느린 플러그인 찾기' } },
          { type: 'dynamicToolCall', id: nid('it'), tool: 'todo', status: 'completed', success: true, contentItems: [], arguments: { op: 'done', task: '이미지 최적화 캐시' } },
        ];
      },
    };
  }
  _usage(t, add = 0) {
    if (t.id !== 'th_pay') return;
    t.used = Math.min(200000, (t.used || 121400) + add);
    this._notify('thread/tokenUsage/updated', { threadId: t.id, tokenUsage: { total: { totalTokens: t.used }, modelContextWindow: 200000 } });
  }
  setSpeed(s) { this.speed = s; }
  on(ev, cb) { this.ls[ev].add(cb); return () => this.ls[ev].delete(cb); }
  _emit(ev, p) { for (const cb of [...this.ls[ev]]) { try { cb(p); } catch (e) { console.error(e); } } }
  _conn(state, extra = {}) { this.connState = state; this._emit('connection', { state, ...extra }); }
  async _tick(ms) { let left = ms; while (left > 0) { await sleep(120); if (this.connState === 'open' && this.speed > 0) left -= 120 * this.speed; } }

  async connect() {
    this._conn('connecting');
    await sleep(900);
    this._conn('open');
    await this.request('initialize', { clientInfo: { name: 'omo-mission-control', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  }
  close() { this._conn('closed'); for (const r of this.runners.values()) r.cancel = true; }
  simulateDisconnect() {
    if (this.connState !== 'open') return;
    this.subs.clear();
    this._conn('reconnecting', { attempt: 1, retryInMs: 3000 });
    setTimeout(() => this._conn('reconnecting', { attempt: 2, retryInMs: 3000 }), 3000);
    setTimeout(() => this._conn('open', { reconnected: true }), 6000);
  }
  reconnectNow() { if (this.connState === 'reconnecting') this._conn('open', { reconnected: true }); }

  _notify(method, params, scoped = true) {
    if (this.connState !== 'open') return;
    if (scoped && params.threadId && !this.subs.has(params.threadId)) return;
    this._emit('notification', { method, params, emittedAtMs: Date.now() });
  }
  _serverRequest(method, params, onResult) {
    const id = ++this.reqSeq;
    const req = { id, method, params, onResult, emitted: false };
    this.pending.set(id, req);
    if (this.subs.has(params.threadId)) this._emitReq(req);
    return id;
  }
  _emitReq(req) {
    req.emitted = true;
    this._emit('serverRequest', { id: req.id, method: req.method, params: req.params });
    if (req.params.timeoutMs && !req.timer) {
      req.timer = setTimeout(() => { if (this.pending.has(req.id)) this._resolve(req.id, { timedOut: true }); }, req.params.timeoutMs);
    }
  }
  _resolve(id, result) {
    const req = this.pending.get(id); if (!req) return;
    this.pending.delete(id); clearTimeout(req.timer);
    this._notify('serverRequest/resolved', { threadId: req.params.threadId, requestId: id });
    req.onResult?.(result);
  }
  respond(id, result) { setTimeout(() => this._resolve(id, result), 120); }
  respondError(id) { this._resolve(id, { decision: 'decline' }); }

  async request(method, params = {}) {
    await sleep(60 + Math.random() * 140);
    if (this.connState !== 'open') throw { code: -32000, message: 'app-server에 연결되어 있지 않습니다' };
    const h = this.h[method];
    if (!h) throw { code: -32601, message: `Method not found: ${method}` };
    return h.call(this, params);
  }

  // ─── helpers ───
  _th(id) { const t = this.threads.get(id); if (!t) throw { code: -32602, message: `thread not found: ${id}` }; return t; }
  _pub(t, withTurns) {
    const { turns, goal, tasks, settings, hidden, loaded, lastError, ...pub } = t;
    const out = { ...pub, cwd: t.cwd, status: t.status };
    if (withTurns) out.turns = turns.map((u) => ({ ...u, items: u.items.map((i) => ({ ...i })) }));
    return out;
  }
  _status(t, status) { t.status = status; t.updatedAt = Date.now(); this._notify('thread/status/changed', { threadId: t.id, status }, false); }
  _curTurn(t) { return t.turns.find((u) => u.status === 'inProgress'); }
  _startTurn(t, input) {
    const turn = { id: nid('tu'), status: 'inProgress', startedAt: Date.now(), items: [] };
    t.turns.push(turn);
    this._status(t, { type: 'active', activeFlags: [] });
    this._notify('turn/started', { threadId: t.id, turn: { id: turn.id, status: 'inProgress', items: [] } });
    if (input) this._item(t, turn, { type: 'userMessage', id: nid('it'), content: input }, true);
    return turn;
  }
  _endTurn(t, turn, status = 'completed', error) {
    turn.status = status; turn.completedAt = Date.now(); if (error) turn.error = error;
    this._notify('turn/completed', { threadId: t.id, turn: { id: turn.id, status, error } });
    this._status(t, status === 'failed' ? { type: 'systemError' } : { type: 'idle' });
    this.runners.delete(t.id);
  }
  _item(t, turn, item, done = false) {
    const it = { ...item, status: done ? item.status ?? 'completed' : 'inProgress' };
    const i = turn.items.findIndex((x) => x.id === it.id);
    if (i >= 0) turn.items[i] = it; else turn.items.push(it);
    t.updatedAt = Date.now();
    this._notify(done ? 'item/completed' : 'item/started', { threadId: t.id, turnId: turn.id, item: it });
    return it;
  }
  _startItem(t, turn, item) { return this._item(t, turn, { ...item, status: 'inProgress' }); }
  _doneItem(t, turn, item, patch = {}) { return this._item(t, turn, { ...item, status: 'completed', ...patch }, true); }
  async _stream(r, t, turn, text) {
    const it = this._startItem(t, turn, { type: 'agentMessage', id: nid('it'), text: '' });
    let acc = '';
    const chunks = text.match(/[\s\S]{1,5}/g) || [];
    for (const c of chunks) {
      if (r.cancel) return;
      await this._tick(55); acc += c;
      const cur = turn.items.find((x) => x.id === it.id); if (cur) cur.text = acc;
      this._notify('item/agentMessage/delta', { threadId: t.id, turnId: turn.id, itemId: it.id, delta: c });
    }
    this._doneItem(t, turn, { ...it, text: acc });
  }
  _todo(t, turn, args) { const it = { type: 'dynamicToolCall', id: nid('it'), tool: 'todo', arguments: args, contentItems: [], success: true }; this._startItem(t, turn, it); this._doneItem(t, turn, { ...it, contentItems: [{ type: 'inputText', text: 'ok' }] }); }
  _tasks(t) { this._notify('extension_event', { threadId: t.id, name: 'omo.task.updated', data: { tasks: t.tasks } }); }
  _run(t, steps) {
    const prev = this.runners.get(t.id); if (prev) prev.cancel = true;
    const r = { cancel: false, steer: [] };
    this.runners.set(t.id, r);
    (async () => {
      for (const s of steps) {
        if (r.cancel) return;
        await this._tick(s[0]);
        if (r.cancel) return;
        while (r.steer.length) { const txt = r.steer.shift(); await this._stream(r, t, this._curTurn(t), `방향 수정 반영합니다: “${txt.slice(0, 40)}”. 남은 작업에 적용할게요.`); await this._tick(600); }
        await s[1](r);
      }
    })();
    return r;
  }
  _approval(t, turn, method, params) {
    return new Promise((res) => this._serverRequest(method, { threadId: t.id, turnId: turn.id, ...params }, res));
  }

  seedRequests() {
    const ci = this.threads.get('th_ci'), copy = this.threads.get('th_copy');
    const ciTurn = ci.turns[0], copyTurn = copy.turns[0];
    const pushItem = { type: 'commandExecution', id: nid('it'), command: 'git push --force-with-lease origin chore/ci-cleanup', cwd: '/Users/me/work/infra', status: 'inProgress', aggregatedOutput: '' };
    ciTurn.items.push(pushItem);
    this._serverRequest('item/commandExecution/requestApproval', { threadId: ci.id, turnId: ciTurn.id, itemId: pushItem.id, command: pushItem.command, cwd: pushItem.cwd, reason: '리베이스로 정리한 커밋을 원격 브랜치에 덮어씁니다. 원격에 다른 사람의 커밋이 있으면 거부됩니다.' }, (res) => {
      const d = res.decision;
      this._run(ci, d === 'accept' || d === 'acceptForSession' ? [
        [500, () => this._startItem(ci, ciTurn, pushItem)],
        [1800, () => this._doneItem(ci, ciTurn, pushItem, { exitCode: 0, durationMs: 2100, aggregatedOutput: 'Enumerating objects: 9, done.\nWriting objects: 100% (5/5), 1.02 KiB | 1.02 MiB/s, done.\nTo github.com:me/infra.git\n + 3f9a1c2...8be04d1 chore/ci-cleanup -> chore/ci-cleanup (forced update)' })],
        [600, () => this._todo(ci, ciTurn, { op: 'done', task: '브랜치에 푸시' })],
        [700, (r) => this._stream(r, ci, ciTurn, '`chore/ci-cleanup`에 푸시했습니다. CI는 **bun 한 잡**으로 합쳐졌고 평균 실행 시간이 4분 → 1분 40초로 줄 것으로 보입니다.')],
        [800, () => this._endTurn(ci, ciTurn)],
      ] : d === 'cancel' ? [[300, () => this._endTurn(ci, ciTurn, 'interrupted')]] : [
        [400, () => this._doneItem(ci, ciTurn, pushItem, { status: 'declined', aggregatedOutput: '' })],
        [600, () => this._todo(ci, ciTurn, { op: 'drop', task: '브랜치에 푸시' })],
        [600, (r) => this._stream(r, ci, ciTurn, '강제 푸시는 건너뛰었습니다. 로컬 브랜치에 커밋이 정리되어 있으니 직접 확인 후 푸시해 주세요.')],
        [700, () => this._endTurn(ci, ciTurn)],
      ]);
    });
    this._serverRequest('item/tool/requestUserInput', { threadId: copy.id, turnId: copyTurn.id, itemId: nid('it'), waitForAnswer: true, timeoutMs: 8 * M, questions: [
      { id: 'tone', header: '톤', question: '온보딩 카피의 톤을 어떻게 할까요?', multiSelect: false, options: [
        { label: '친근한 존댓말', description: '“시작해 볼까요?” 처럼 가볍고 부드럽게' },
        { label: '표준 존댓말', description: '“시작해 보세요” 처럼 무난하게' },
        { label: '간결한 명사형', description: '“시작하기” 처럼 짧게' } ] },
      { id: 'scope', header: '범위', question: '이번에 카피를 바꿀 화면을 모두 골라 주세요.', multiSelect: true, options: [
        { label: '환영', description: '첫 화면 제목·부제' }, { label: '권한 요청', description: '알림·위치 권한 안내' }, { label: '프로필 설정', description: '입력 필드 라벨·도움말' }, { label: '완료', description: '마지막 CTA' } ] },
    ] }, (res) => {
      if (res.timedOut) { this._run(copy, [[400, (r) => this._stream(r, copy, copyTurn, '답이 없어 **표준 존댓말**로 전체 화면을 수정하겠습니다.')], [600, () => this._endTurn(copy, copyTurn)]]); return; }
      const tone = res.answers?.tone?.answers?.[0] ?? '표준 존댓말';
      const scope = res.answers?.scope?.answers ?? [];
      this._run(copy, [
        [500, () => this._todo(copy, copyTurn, { op: 'init', list: [{ phase: '카피', items: scope.length ? scope.map((s) => `${s} 화면 수정`) : ['전체 화면 수정'] }] })],
        [900, (r) => this._stream(r, copy, copyTurn, `**${tone}** 톤으로 ${scope.length ? scope.join(', ') : '전체'} 화면을 고칩니다.${res.comment ? `\n\n메모 반영: “${res.comment}”` : ''}`)],
        [900, () => { const it = fc('src/onboarding/copy.ko.json', DIFF_COPY); this._startItem(copy, copyTurn, it); this._notify('turn/diff/updated', { threadId: copy.id, turnId: copyTurn.id, diff: DIFF_COPY }); }],
        [900, () => { const it = copyTurn.items.at(-1); this._doneItem(copy, copyTurn, it); }],
        ...scope.map((s) => [500, () => this._todo(copy, copyTurn, { op: 'done', task: `${s} 화면 수정` })]),
        [700, () => this._endTurn(copy, copyTurn)],
      ]);
    });
  }

  _payScript(t) {
    const turn = this._curTurn(t); if (!turn) return;
    const task = (id, patch) => { t.tasks = t.tasks.map((x) => (x.task_id === id ? { ...x, ...patch } : x)); this._tasks(t); };
    const test = cmd('bun test src/payments', PAY, '', 0); const long = longTestOutput();
    const fStripe = fc('src/payments/stripe.ts', DIFF_STRIPE, 'add'); const fSvc = fc('src/payments/service.ts', DIFF_SERVICE);
    const rmLegacy = { type: 'fileChange', id: nid('it'), changes: [{ path: 'src/payments/stripe-legacy.ts', kind: 'delete', diff: '--- a/src/payments/stripe-legacy.ts\n+++ /dev/null\n@@ -1,4 +0,0 @@\n-// deprecated: use StripeAdapter\n-import { PaymentService } from \'./service\'\n-export const chargeLegacy = (b: unknown) => PaymentService.call(\'stripe\', b)\n-export default chargeLegacy' }] };
    let diff = DIFF_IFACE + '\n' + DIFF_TOSS;
    const pushDiff = (d) => { diff += '\n' + d; this._notify('turn/diff/updated', { threadId: t.id, turnId: turn.id, diff }); this._usage(t, 4200); };
    this._run(t, [
      [1200, () => { this._tasks(t); pushDiff(''); }],
      [1800, () => this._item(t, turn, think('librarian 결과: idempotencyKey는 요청 옵션으로 전달.', 'manual capture로 authorize/capture를 분리하면 Toss와 의미가 맞는다.'), true)],
      [1400, () => this._startItem(t, turn, fStripe)],
      [2200, () => { this._doneItem(t, turn, fStripe); pushDiff(DIFF_STRIPE); }],
      [1200, () => task('bg_7f2a', { live_progress: undefined, final_response: 'stripe.* 호출은 3곳, 모두 v14 API. charges.create는 subscriptions/renew.ts 한 곳뿐.', run_stats: { tool_calls: 19, tokens: 44100, duration_ms: 260000 } })],
      [1000, () => this._todo(t, turn, { op: 'done', task: 'StripeAdapter 구현' })],
      [1600, () => task('bg_7f2c', { live_progress: { activity: '부분 capture 처리 방식 검토', started_at: Date.now() - 150000, current_tool: 'think' }, run_stats: { tool_calls: 6 } })],
      [1400, () => this._startItem(t, turn, fSvc)],
      [2400, () => { this._doneItem(t, turn, fSvc); pushDiff(DIFF_SERVICE); }],
      [1200, async () => {
        const r = await this._approval(t, turn, 'item/fileChange/requestApproval', { itemId: rmLegacy.id, reason: '더 이상 쓰지 않는 레거시 Stripe 래퍼를 삭제합니다. subscriptions/renew.ts는 StripeAdapter로 옮겼습니다.', changes: rmLegacy.changes });
        if (r.decision === 'accept' || r.decision === 'acceptForSession') { this._doneItem(t, turn, rmLegacy); pushDiff(rmLegacy.changes[0].diff); }
        else this._doneItem(t, turn, { ...rmLegacy, status: 'declined' });
      }],
      [1000, () => this._todo(t, turn, { op: 'done', task: 'PaymentService 의존성 주입으로 교체' })],
      [1200, () => task('bg_7f2c', { live_progress: undefined, final_response: '경계는 적절합니다. 부분 capture는 Stripe 전용이므로 `capture(amount?)`를 선택 인자로 두고 Toss에서는 전체 금액만 허용하세요.', run_stats: { tool_calls: 8, tokens: 92000, duration_ms: 310000 } })],
      [1400, () => this._todo(t, turn, { op: 'append', phase: '검증', items: ['부분 capture 가드 추가'] })],
      [1500, () => this._startItem(t, turn, test)],
      [3000, () => this._doneItem(t, turn, test, { exitCode: 0, durationMs: 2410, aggregatedOutput: long })],
      [900, () => this._todo(t, turn, { op: 'done', task: '단위 테스트 추가' })],
      [1400, () => this._todo(t, turn, { op: 'done', task: '통합 테스트 실행' })],
      [1400, () => this._todo(t, turn, { op: 'done', task: '부분 capture 가드 추가' })],
      [900, (r) => this._stream(r, t, turn, '리팩터링을 마쳤습니다.\n\n- `PaymentAdapter` + Toss/Stripe 구현\n- `PaymentService`는 어댑터 주입 방식으로 교체\n- 테스트 **624개 통과**, 커버리지 58% → 91%\n\n레거시 래퍼 삭제 여부는 승인 결과대로 반영했습니다.')],
      [1000, () => { t.goal = { ...t.goal, status: 'complete', tokensUsed: 1610000 }; this._notify('thread/goal/updated', { threadId: t.id, goal: t.goal }, false); this._endTurn(t, turn); }],
    ]);
  }
  _oracleScript(t) {
    const turn = this._curTurn(t); if (!turn) return;
    this._run(t, [
      [2000, () => this._item(t, turn, dyn('read', { path: 'src/payments/toss.ts' }, '14 lines'), true)],
      [2400, () => this._item(t, turn, think('Toss는 부분 capture가 없다.', 'capture(amount?)를 선택 인자로 두는 편이 인터페이스를 덜 오염시킨다.'), true)],
      [2600, (r) => this._stream(r, t, turn, '경계는 적절합니다. 부분 capture는 Stripe 전용이므로 `capture(amount?)`를 선택 인자로 두고 Toss에서는 전체 금액만 허용하세요.')],
      [800, () => this._endTurn(t, turn)],
    ]);
  }
  _genericScript(t, turn, text) {
    this._run(t, [
      [900, () => this._item(t, turn, think(`요청 파악: ${text.slice(0, 60)}`), true)],
      [1300, () => { const it = dyn('read', { path: 'README.md' }, '82 lines'); this._startItem(t, turn, it); setTimeout(() => this._doneItem(t, turn, it), 900 / Math.max(this.speed, 0.2)); }],
      [1800, (r) => this._stream(r, t, turn, `확인했습니다. 요청하신 “${text.slice(0, 50)}${text.length > 50 ? '…' : ''}” 작업을 진행했고, 변경은 없습니다. 이어서 할 일이 있으면 알려 주세요.`)],
      [700, () => this._endTurn(t, turn)],
    ]);
  }

  h = {
    initialize() { return { userAgent: 'omo-app-server/5.0.3 (mock)', serverInfo: { name: 'omo', version: '5.0.3' } }; },
    'thread/list'({ archived = false, cursor, limit = 50 }) {
      const all = [...this.threads.values()].filter((t) => !t.hidden && !!t.archived === !!archived).sort((a, b) => b.updatedAt - a.updatedAt);
      const start = cursor ? Number(cursor) : 0;
      const data = all.slice(start, start + limit).map((t) => this._pub(t));
      return { data, nextCursor: start + limit < all.length ? String(start + limit) : null };
    },
    'thread/loaded/list'() { return { data: [...this.threads.values()].filter((t) => t.loaded).map((t) => t.id) }; },
    'thread/read'({ threadId, includeTurns }) { return { thread: this._pub(this._th(threadId), includeTurns) }; },
    'thread/search'({ query = '', sourceKinds = ['appServer'] }) {
      const q = query.toLowerCase();
      return { data: [...this.threads.values()].filter((t) => !t.hidden && sourceKinds.includes(t.source) && (t.name + t.preview + t.cwd).toLowerCase().includes(q)).map((t) => this._pub(t)), nextCursor: null };
    },
    'thread/resume'({ threadId }) {
      const t = this._th(threadId);
      this.subs.add(threadId);
      if (!t.loaded) { t.loaded = true; if (t.status.type === 'notLoaded') this._status(t, { type: 'idle' }); }
      setTimeout(() => {
        for (const req of this.pending.values()) if (req.params.threadId === threadId) this._emitReq(req);
        if (t.tasks) this._tasks(t);
        this._usage(t);
        if (!this.started.has(threadId)) { this.started.add(threadId); if (threadId === 'th_pay') this._payScript(t); if (threadId === 'th_oracle') this._oracleScript(t); }
      }, 300);
      return { thread: this._pub(t, true), model: t.settings.model, reasoningEffort: t.settings.effort };
    },
    'thread/start'({ cwd }) {
      const t = { id: nid('th'), name: null, preview: '', cwd, source: 'appServer', path: `~/.omo/sessions/new.jsonl`, archived: false, loaded: true, hidden: false, goal: null, tasks: null, settings: { model: 'claude-opus-5', effort: 'high' }, turns: [], status: { type: 'idle' }, createdAt: Date.now(), updatedAt: Date.now() };
      this.threads.set(t.id, t); this.subs.add(t.id);
      this._notify('thread/started', { thread: this._pub(t) }, false);
      return { thread: this._pub(t), model: t.settings.model, reasoningEffort: t.settings.effort };
    },
    'thread/unsubscribe'({ threadId }) {
      this.subs.delete(threadId);
      for (const req of [...this.pending.values()]) if (req.params.threadId === threadId && req.method.includes('requestApproval')) this._resolve(req.id, { decision: 'decline' });
      return { status: 'unsubscribed' };
    },
    'thread/name/set'({ threadId, name }) { const t = this._th(threadId); t.name = name; this._notify('thread/name/updated', { threadId, threadName: name }, false); return {}; },
    'thread/fork'({ threadId }) {
      const s = this._th(threadId);
      const t = { ...s, id: nid('th'), name: `${s.name ?? '세션'} (복제)`, createdAt: Date.now(), updatedAt: Date.now(), status: { type: 'idle' }, loaded: true, source: 'appServer', archived: false, tasks: null, turns: s.turns.map((u) => ({ ...u, status: u.status === 'inProgress' ? 'interrupted' : u.status, items: u.items.map((i) => ({ ...i, id: nid('it'), status: i.status === 'inProgress' ? 'completed' : i.status })) })) };
      this.threads.set(t.id, t); this.subs.add(t.id);
      this._notify('thread/started', { thread: this._pub(t) }, false);
      return { thread: this._pub(t, true) };
    },
    'thread/archive'({ threadId }) { const t = this._th(threadId); t.archived = true; this.subs.delete(threadId); return {}; },
    'thread/unarchive'({ threadId }) { const t = this._th(threadId); t.archived = false; this._notify('thread/unarchived', { threadId }, false); return { thread: this._pub(t) }; },
    'thread/delete'({ threadId }) { this._th(threadId); this.threads.delete(threadId); this.subs.delete(threadId); return {}; },
    'thread/goal/get'({ threadId }) { return { goal: this._th(threadId).goal }; },
    'thread/goal/set'({ threadId, objective, status, tokenBudget }) {
      const t = this._th(threadId);
      t.goal = { tokensUsed: 0, ...(t.goal || {}), ...(objective !== undefined && { objective }), ...(status && { status }), ...(tokenBudget !== undefined && { tokenBudget }) };
      if (!t.goal.status) t.goal.status = 'active';
      this._notify('thread/goal/updated', { threadId, goal: t.goal }, false); return { goal: t.goal };
    },
    'thread/goal/clear'({ threadId }) { this._th(threadId).goal = null; this._notify('thread/goal/cleared', { threadId }, false); return {}; },
    'thread/compact/start'({ threadId }) {
      const t = this._th(threadId);
      const turn = this._curTurn(t) || t.turns.at(-1); if (!turn) throw { code: -32602, message: '압축할 기록이 없습니다' };
      const it = { type: 'contextCompaction', id: nid('it') };
      this._startItem(t, turn, it); setTimeout(() => this._doneItem(t, turn, it), 1600);
      return {};
    },
    'thread/settings/update'({ threadId, model, effort }) { const t = this._th(threadId); if (model) t.settings.model = model; if (effort) t.settings.effort = effort; return {}; },
    'model/list'() { return { data: this.models, nextCursor: null }; },
    'turn/start'({ threadId, input }) {
      const t = this._th(threadId);
      if (this._curTurn(t)) throw { code: -32600, message: '이미 진행 중인 턴이 있습니다' };
      if (!t.name) { t.name = input[0].text.slice(0, 24); this._notify('thread/name/updated', { threadId, threadName: t.name }, false); }
      t.preview = input[0].text;
      const turn = this._startTurn(t, input);
      this._genericScript(t, turn, input[0].text);
      return { turn: { id: turn.id, status: 'inProgress', items: [] } };
    },
    'turn/steer'({ threadId, expectedTurnId, input }) {
      const t = this._th(threadId); const turn = this._curTurn(t);
      if (!turn || turn.id !== expectedTurnId) throw { code: -32600, message: '진행 중인 턴이 바뀌었습니다. 다시 시도하세요' };
      this._item(t, turn, { type: 'userMessage', id: nid('it'), content: input }, true);
      const r = this.runners.get(threadId);
      if (r) r.steer.push(input[0].text); else this._genericScript(t, turn, input[0].text);
      return { turnId: turn.id };
    },
    'turn/interrupt'({ threadId, turnId }) {
      const t = this._th(threadId); const turn = t.turns.find((u) => u.id === turnId);
      const r = this.runners.get(threadId); if (r) r.cancel = true;
      for (const req of [...this.pending.values()]) if (req.params.threadId === threadId) this._resolve(req.id, { decision: 'cancel', silent: true });
      if (turn && turn.status === 'inProgress') {
        for (const it of turn.items) if (it.status === 'inProgress') this._doneItem(t, turn, { ...it, status: 'interrupted' });
        this._endTurn(t, turn, 'interrupted');
      }
      return {};
    },
  };
}
