// Rebuild a session's todo list from its latest todowrite call.
// Mirrors replayTodos in app/store.js (the prototype's runtime copy).
import type { Item, TodoState, TodoStatus } from './protocol';

type Phase = TodoState['phases'][number];

// opencode2's todowrite replaces the whole list each call, every item with a status, and has no phases.
const WRITE_STATUS: Record<string, TodoStatus> = { pending: 'pending', in_progress: 'in_progress', completed: 'completed', cancelled: 'abandoned' };
type Written = { todos: { content?: unknown; status?: unknown }[] };
const writtenTodos = (a: Written): Phase[] =>
  a.todos.length ? [{ name: '할 일', tasks: a.todos.map((t) => ({ text: String(t?.content ?? ''), status: WRITE_STATUS[String(t?.status)] ?? 'pending' })) }] : [];

/** null = the session never wrote a todo list. */
export function replayTodos(items: Item[]): TodoState | null {
  let phases: Phase[] | null = null;
  for (const it of items) {
    if (it.type !== 'dynamicToolCall' || it.tool !== 'todowrite') continue;
    let a: unknown = it.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = null; } }
    // A call still streaming its input has no list yet.
    if (a && typeof a === 'object' && Array.isArray((a as Written).todos)) phases = writtenTodos(a as Written);
  }
  return phases && { phases };
}

export function todoProgress(t: TodoState | null) {
  if (!t || !t.phases.length) return null;
  const flat = t.phases.flatMap((p) => p.tasks.map((x) => ({ ...x, phase: p.name })));
  const live = flat.filter((x) => x.status !== 'abandoned');
  const cur = flat.find((x) => x.status === 'in_progress') ?? flat.find((x) => x.status === 'pending');
  return { done: live.filter((x) => x.status === 'completed').length, total: live.length, phase: cur?.phase ?? t.phases.at(-1)!.name, current: cur?.text ?? null };
}
