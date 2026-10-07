// omo app-server protocol (Codex app-server compatible JSON-RPC over WebSocket, no `jsonrpc` field).
// Only the surface listed in the brief is modelled. Every server payload is treated as partial.

export type RequestId = number | string;

export interface RpcRequest<P = unknown> { id: RequestId; method: string; params?: P }
export interface RpcResponse<R = unknown> { id: RequestId; result: R }
export interface RpcErrorResponse { id: RequestId; error: { code: number; message: string; data?: unknown } }
export interface RpcNotification<P = unknown> { method: string; params: P; emittedAtMs?: number }
/** Server → client request (approval / question). Answer with {id, result}. */
export type ServerRequest = RpcRequest<ServerRequestParams> & { method: ServerRequestMethod };

export const METHOD_NOT_FOUND = -32601;

// ── initialize ──
export interface InitializeParams { clientInfo: { name: string; version: string }; capabilities: { experimentalApi: true } }
export interface InitializeResult { userAgent?: string; serverInfo?: { name: string; version: string } }

// ── threads ──
export type ThreadSource = 'cli' | 'appServer' | (string & {});
/** Known: idle, notLoaded, active, systemError. Unknown values must render safely. */
export interface ThreadStatus { type: 'idle' | 'notLoaded' | 'active' | 'systemError' | (string & {}); activeFlags?: string[] }
export interface Thread {
  id: string; name?: string | null; preview?: string; cwd: string; source: ThreadSource; status: ThreadStatus;
  /** omo app-server wire values are Unix seconds; the browser Store normalizes them to milliseconds. */
  createdAt: number; updatedAt: number; path?: string; archived?: boolean; turns?: Turn[];
}
export interface Page<T> { data: T[]; nextCursor: string | null }

export interface ThreadListParams { cursor?: string | null; limit?: number; archived?: boolean }
export interface ThreadReadParams { threadId: string; includeTurns?: boolean }
/** experimental; case-insensitive. Pass both kinds to find terminal + dashboard sessions. */
export interface ThreadSearchParams { query: string; sourceKinds?: ThreadSource[]; cursor?: string | null }
export interface ThreadStartParams { cwd: string }
export interface ThreadStartResult { thread: Thread; model?: string; reasoningEffort?: string }
export interface ThreadResumeResult { thread: Thread; model?: string; reasoningEffort?: string }

export type GoalStatus = 'active' | 'paused' | 'complete';
export interface Goal { objective: string; status: GoalStatus; tokenBudget?: number; tokensUsed?: number }

export interface Model { id: string; displayName?: string; supportedReasoningEfforts?: string[] }

// ── turns & items ──
export type TurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | (string & {});
export interface Turn { id: string; status: TurnStatus; items: Item[]; error?: { message: string }; /** ms of the turn's latest message; set by omonitor's file history, not app-server */ lastAt?: number }
export type TextInput = { type: 'text'; text: string };

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted' | (string & {});
interface ItemBase { id: string; status?: ItemStatus }
export interface UserMessageItem extends ItemBase { type: 'userMessage'; content: TextInput[] }
export interface AgentMessageItem extends ItemBase { type: 'agentMessage'; text: string }
export interface ReasoningItem extends ItemBase { type: 'reasoning'; summary?: string[]; content?: string[] }
export interface CommandExecutionItem extends ItemBase { type: 'commandExecution'; command: string; cwd?: string; exitCode?: number | null; aggregatedOutput?: string; durationMs?: number }
/** omo sends `kind` as `{ type }`; the browser Store normalizes it to the plain string. */
export interface FileChange { path: string; kind: 'add' | 'delete' | 'update' | { type: 'add' | 'delete' | 'update' } | (string & {}); diff?: string }
export interface FileChangeItem extends ItemBase { type: 'fileChange'; changes: FileChange[] }
export interface McpToolCallItem extends ItemBase { type: 'mcpToolCall'; server: string; tool: string; arguments?: unknown; result?: { content?: { type: string; text?: string }[] } }
export interface DynamicToolCallItem extends ItemBase { type: 'dynamicToolCall'; tool: string; arguments?: unknown; success?: boolean; contentItems?: { type: string; text?: string }[] }
export interface WebSearchItem extends ItemBase { type: 'webSearch'; query?: string }
export interface ContextCompactionItem extends ItemBase { type: 'contextCompaction' }
export type Item = UserMessageItem | AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem | McpToolCallItem | DynamicToolCallItem | WebSearchItem | ContextCompactionItem;

export interface TurnStartParams { threadId: string; input: TextInput[] }
export interface TurnSteerParams { threadId: string; expectedTurnId: string; input: TextInput[] }
export interface TurnInterruptParams { threadId: string; turnId: string }
export interface ThreadSettingsUpdateParams { threadId: string; model?: string; effort?: string }

// ── todo tool (arrives as dynamicToolCall with tool === 'todo') ──
export type TodoOp =
  | { op: 'init'; list: { phase: string; items: string[] }[] }
  | { op: 'start' | 'done' | 'drop' | 'rm'; task?: string; phase?: string }
  | { op: 'append'; phase?: string; items: string[] }
  | { op: 'view' };
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
export interface TodoState { phases: { name: string; tasks: { text: string; status: TodoStatus }[] }[]; raw: string | null }

// ── subagents (extension_event name === 'omo.task.updated'); every field optional ──
export interface OmoTask {
  task_id?: string; name?: string; task_summary?: string; description?: string; agent_type?: string; category?: string; model?: string;
  child_session_id?: string; run_stats?: Record<string, number>; live_progress?: { activity?: string; started_at?: number; current_tool?: string };
  final_response?: string; error_message?: string;
}

// ── notifications ──
export interface NotificationMap {
  'thread/started': { thread: Thread };
  'thread/status/changed': { threadId: string; status: ThreadStatus };
  'thread/name/updated': { threadId: string; threadName: string };
  'thread/goal/updated': { threadId: string; goal: Goal };
  'thread/goal/cleared': { threadId: string };
  'thread/unarchived': { threadId: string };
  'turn/started': { threadId: string; turn: Pick<Turn, 'id' | 'status'> };
  'turn/completed': { threadId: string; turn: Pick<Turn, 'id' | 'status' | 'error'> };
  'item/started': { threadId: string; turnId: string; item: Item };
  'item/completed': { threadId: string; turnId: string; item: Item };
  'item/agentMessage/delta': { threadId: string; turnId: string; itemId: string; delta: string };
  'item/reasoning/textDelta': { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number };
  'turn/diff/updated': { threadId: string; turnId: string; diff: string };
  error: { threadId?: string; error?: { message: string }; message?: string };
  extension_event: { threadId: string; name: string; data: unknown };
  'serverRequest/resolved': { threadId: string; requestId: RequestId };
  /** Not in the guaranteed list — the UI shows context size only if this arrives. */
  'thread/tokenUsage/updated': { threadId: string; tokenUsage: { total?: { totalTokens?: number }; modelContextWindow?: number } };
}
export type NotificationMethod = keyof NotificationMap;

// ── server → client requests ──
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export interface CommandApprovalParams { threadId: string; turnId: string; itemId: string; command: string; cwd?: string; reason?: string }
export interface FileChangeApprovalParams { threadId: string; turnId: string; itemId: string; changes: FileChange[]; reason?: string }
export interface UserInputQuestion { id: string; header?: string; question: string; options: { label: string; description?: string }[] | null; multiSelect?: boolean; isOther?: boolean }
export interface UserInputParams { threadId: string; turnId: string; itemId: string; questions: UserInputQuestion[]; waitForAnswer?: boolean; timeoutMs?: number }
export type ServerRequestMethod = 'item/commandExecution/requestApproval' | 'item/fileChange/requestApproval' | 'item/tool/requestUserInput';
export type ServerRequestParams = CommandApprovalParams | FileChangeApprovalParams | UserInputParams;
/** Sent as a response to the server request ID (not a client request). */
export interface UserInputAnsweredParams { answers: Record<string, { answers: string[] }>; comment?: string }

// ── Bun backend extras (not app-server) ──
export interface Skill { kind: 'command' | 'skill' | 'keyword'; name: string; desc: string; source: 'builtin' | 'user'; insert?: string; label?: string }
/** GET /api/omo/version: the installed omo against the npm `latest` tag (cached 10 minutes by the backend). */
export interface OmoVersion { current: string; latest: string; updateAvailable: boolean; checkedAt: number }
/** One limit window of a subscription plan; percent is 0-100 and resetsAt is in ms. */
export interface UsageWindow { label: string; percent: number; resetsAt: number | null }
/** A Claude or ChatGPT login of omo. expired: the token ran out and waits for omo to refresh it. */
export interface UsageAccount { provider: 'claude' | 'chatgpt'; name: string; plan: string | null; windows: UsageWindow[]; error?: string; expired?: boolean }
/** GET /api/usage: plan usage read with omo's tokens from auth.json (cached 30 seconds by the backend). */
export interface PlanUsage { checkedAt: number; accounts: UsageAccount[] }
/** POST /api/omo/update: `omo update`, then `omo app-server daemon restart`. restartError means the update went in but the restart failed. */
export interface OmoUpdateResult { update: string; restart?: string; restartError?: string }
