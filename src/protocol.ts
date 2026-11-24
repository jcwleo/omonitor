// The dashboard's session protocol: Codex app-server compatible JSON-RPC over WebSocket, no `jsonrpc` field.
// The backend translates between this protocol and the opencode2 server.
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
/** Known: idle, active, systemError. Unknown values must render safely. */
export interface ThreadStatus { type: 'idle' | 'active' | 'systemError' | (string & {}); activeFlags?: string[] }
export interface Thread {
  id: string; name?: string | null; preview?: string; cwd: string; source: string; status: ThreadStatus;
  /** Session timestamps in milliseconds. */
  createdAt: number; updatedAt: number; path?: string; archived?: boolean; turns?: Turn[]; revert?: Revert | null; commands?: RunningCommand[];
}
/** A shell command still running (opencode2), background ones included. `by` names the subagent that ran it; cwd may be ''. */
export interface RunningCommand { id: string; command: string; cwd: string; startedAt: number; by?: string }
/** A staged revert: the user message it starts at, how many of the user's messages it took back (null when unknown) and
 * the files it put back. The next message commits it; thread/revert/clear undoes it. */
export interface Revert { messageId: string; count: number | null; files: { path: string; status: 'added' | 'deleted' | 'modified' | (string & {}); add: number; del: number }[] }
export interface Page<T> { data: T[]; nextCursor: string | null }

export interface ThreadListParams { cursor?: string | null; limit?: number; archived?: boolean }
export interface ThreadReadParams { threadId: string; includeTurns?: boolean }
export interface ThreadStartParams { cwd: string }
export interface ThreadStartResult { thread: Thread; model?: string; reasoningEffort?: string }
export interface ThreadResumeResult { thread: Thread; model?: string; reasoningEffort?: string }

export interface Model { id: string; displayName?: string; supportedReasoningEfforts?: string[] }

// ── turns & items ──
export type TurnStatus = 'inProgress' | 'completed' | 'failed' | 'interrupted' | (string & {});
export interface Turn { id: string; status: TurnStatus; items: Item[]; error?: { message: string }; /** ms of the latest message in a saved turn */ lastAt?: number }
export type TextInput = { type: 'text'; text: string };

export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined' | 'interrupted' | (string & {});
interface ItemBase { id: string; status?: ItemStatus }
export interface UserMessageItem extends ItemBase { type: 'userMessage'; content: TextInput[] }
export interface AgentMessageItem extends ItemBase { type: 'agentMessage'; text: string }
export interface ReasoningItem extends ItemBase { type: 'reasoning'; summary?: string[]; content?: string[] }
export interface CommandExecutionItem extends ItemBase { type: 'commandExecution'; command: string; cwd?: string; exitCode?: number | null; aggregatedOutput?: string; durationMs?: number }
export interface FileChange { path: string; kind: 'add' | 'delete' | 'update' | { type: 'add' | 'delete' | 'update' } | (string & {}); diff?: string }
export interface FileChangeItem extends ItemBase { type: 'fileChange'; changes: FileChange[] }
export interface McpToolCallItem extends ItemBase { type: 'mcpToolCall'; server: string; tool: string; arguments?: unknown; result?: { content?: { type: string; text?: string }[] } }
/** contentItems: `inputText` with the result text, then one `inputImage` per image in the result (served by the backend). */
export interface DynamicToolCallItem extends ItemBase { type: 'dynamicToolCall'; tool: string; arguments?: unknown; success?: boolean; contentItems?: { type: string; text?: string; imageUrl?: string }[] }
export interface WebSearchItem extends ItemBase { type: 'webSearch'; query?: string }
export interface ContextCompactionItem extends ItemBase { type: 'contextCompaction' }
export type Item = UserMessageItem | AgentMessageItem | ReasoningItem | CommandExecutionItem | FileChangeItem | McpToolCallItem | DynamicToolCallItem | WebSearchItem | ContextCompactionItem;

export interface TurnStartParams { threadId: string; input: TextInput[] }
export interface TurnSteerParams { threadId: string; expectedTurnId: string; input: TextInput[] }
export interface TurnInterruptParams { threadId: string; turnId: string }
export interface ThreadSettingsUpdateParams { threadId: string; model?: string; effort?: string }

// ── todo list (opencode2's todowrite, a dynamicToolCall whose arguments carry the whole list) ──
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
export interface TodoState { phases: { name: string; tasks: { text: string; status: TodoStatus }[] }[] }

// ── subagents ──
/** agent/message: deliver directly to a child of this parent; viewing history never invokes this method. */
export interface AgentMessageParams { readonly threadId: string; readonly parentThreadId: string; readonly text: string }
export interface AgentTask {
  task_id?: string; name?: string; task_summary?: string; description?: string; agent_type?: string; category?: string; model?: string;
  child_session_id?: string; run_stats?: Record<string, number | undefined>; live_progress?: { activity?: string; started_at?: number | null; current_tool?: string } | null;
  final_response?: string; error_message?: string;
}

// ── notifications ──
export interface NotificationMap {
  'thread/started': { thread: Thread };
  'thread/status/changed': { threadId: string; status: ThreadStatus };
  'thread/name/updated': { threadId: string; threadName: string };
  'thread/unarchived': { threadId: string };
  'turn/started': { threadId: string; turn: Pick<Turn, 'id' | 'status'> };
  'turn/completed': { threadId: string; turn: Pick<Turn, 'id' | 'status' | 'error'> };
  'item/started': { threadId: string; turnId: string; item: Item };
  'item/completed': { threadId: string; turnId: string; item: Item };
  'item/agentMessage/delta': { threadId: string; turnId: string; itemId: string; delta: string };
  'item/reasoning/textDelta': { threadId: string; turnId: string; itemId: string; delta: string; contentIndex: number };
  'turn/diff/updated': { threadId: string; turnId: string; diff: string };
  error: { threadId?: string; error?: { message: string }; message?: string };
  'thread/agents/updated': { threadId: string; agents: AgentTask[] };
  'thread/revert/updated': { threadId: string; revert: Revert | null };
  /** opencode2 only: every command still running in the session's shells (also on Thread as `commands`). */
  'thread/commands/updated': { threadId: string; commands: RunningCommand[] };
  /** opencode2 only: models, providers or commands changed (a location it was loading is in); read model/list and the palette again. */
  'catalog/updated': Record<string, never>;
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
/** GET /api/opencode/version (null without opencode2): current is the installed CLI, latest the npm @opencode/cli release,
 * running the version the shared service answers with; stale: the service still runs a binary from before an upgrade. */
export interface OpencodeVersion { current: string; latest: string; running: string | null; updateAvailable: boolean; stale: boolean; checkedAt: number }
/** POST /api/opencode/update: `opencode upgrade`, then `opencode service restart`. restartError: the upgrade went in but the restart failed. */
export interface OpencodeUpdateResult { update: string; restart?: string; restartError?: string }
/** POST /api/open { target, cwd? }, only from a dashboard served on the machine itself: a URL went to the default browser,
 * a file or folder to its default app, or something that would run when opened was shown in Finder. */
export interface OpenResult { opened: 'browser' | 'app' | 'finder' }
/** One limit window of a subscription plan; percent is 0-100 and resetsAt is in ms. */
export interface UsageWindow { label: string; percent: number; resetsAt: number | null }
export type UsageProvider = 'claude' | 'chatgpt';
export interface UsageAuthAccount { provider: UsageProvider; connected: boolean; email: string | null; expiresAt: number | null }
export interface UsageLogin { provider: UsageProvider; id: string; url: string; expiresAt: number; mode: 'callback' | 'paste'; status: 'pending' | 'exchanging' | 'complete' | 'error'; error?: string }
export interface UsageAuthState { accounts: UsageAuthAccount[]; pending: UsageLogin[] }
export interface UsageAccount { provider: UsageProvider; name: string; plan: string | null; windows: UsageWindow[]; source?: 'omonitor'; error?: string; expired?: boolean; errorCode?: 'expired' | 'authentication' | 'credentials' | 'unavailable' }
/** GET /api/usage: omonitor-owned logins; Claude cached for 3 minutes, ChatGPT for 30 seconds. */
export interface PlanUsage { checkedAt: number; accounts: UsageAccount[] }
/** A commit on omonitor's upstream branch that this clone lacks; at is the commit time in ms. */
export interface OmonitorCommit { sha: string; subject: string; at: number }
/** GET /api/omonitor/version (update.ts): this clone against its upstream branch after a git fetch (cached 10 minutes by
 * the backend), null when omonitor does not run from a git clone with an upstream. blocked: why a one-click update would
 * not run (local commits or edits). restartNeeded: the update changes server code; static files need only a reload. */
export interface OmonitorVersion { current: string; latest: string; upstream: string; behind: number; ahead: number; commits: OmonitorCommit[]; updateAvailable: boolean; blocked: string | null; restartNeeded: boolean; fetchError: string | null; checkedAt: number }
/** A worktree of a repo (`git worktree list`). branch is null on a detached HEAD; missing: its folder is gone (prunable).
 * ahead/behind count against upstream; changes: files with uncommitted changes, untracked ones included. */
export interface GitWorktree { path: string; branch: string | null; head: string | null; main: boolean; locked: boolean; missing: boolean; upstream: string | null; ahead: number; behind: number; changes: number }
/** A repo by its common git dir: root is the main worktree's folder, name its folder name. */
export interface GitRepo { root: string; name: string; worktrees: GitWorktree[] }
/** The worktree containing the session's cwd. No worktree is inferred from the conversation. */
export interface ThreadGit { repo: string; worktree: string; branch: string | null; head: string | null; removed: boolean; inferred: boolean }
/** POST /api/git/summary { threads: [{ id, cwd }] }: repos keyed by common git dir, sessions by thread id. */
export interface GitSummary { checkedAt: number; repos: Record<string, GitRepo>; threads: Record<string, ThreadGit> }
/** POST /api/omonitor/update: fast-forward, then bun install when the lockfile moved. restarting: the server exits now and
 * its service starts the new code; restartNeeded without restarting: it runs outside the service and needs a manual restart. */
export interface OmonitorUpdateResult { from: string; to: string; installed: boolean; restartNeeded: boolean; restarting: boolean }
