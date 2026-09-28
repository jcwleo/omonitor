// Rebuild a session's todo list by replaying its `todo` dynamicToolCall items in order.
// Mirrors replayTodos in app/store.js (the prototype's runtime copy).
import type { Item, TodoOp, TodoState, TodoStatus } from './protocol';

type Phase = TodoState['phases'][number];

function apply(phases: Phase[], a: TodoOp): Phase[] {
  const P: Phase[] = phases.map((p) => ({ name: p.name, tasks: p.tasks.map((t) => ({ ...t })) }));
  const all = () => P.flatMap((p) => p.tasks);
  const phaseOf = (n: string) => P.find((p) => p.name === n);
  const targets = (x: { task?: string; phase?: string }) =>
    x.task != null ? all().filter((t) => t.text === String(x.task)) : x.phase != null ? phaseOf(String(x.phase))?.tasks ?? [] : [];
  const set = (x: { task?: string; phase?: string }, s: TodoStatus) => targets(x).forEach((t) => { t.status = s; });
  switch (a.op) {
    case 'init':
      if (!Array.isArray(a.list)) throw new Error('init.list missing');
      return a.list.map((p) => ({ name: String(p?.phase ?? ''), tasks: (Array.isArray(p?.items) ? p.items : []).map((s) => ({ text: String(s), status: 'pending' as const })) }));
    case 'start': set(a, 'in_progress'); return P;
    case 'drop': set(a, 'abandoned'); return P;
    case 'done': {
      set(a, 'completed');
      // Completing a task promotes the earliest unfinished task (phase order) if nothing is running.
      if (!all().some((t) => t.status === 'in_progress')) {
        const next = all().find((t) => t.status === 'pending');
        if (next) next.status = 'in_progress';
      }
      return P;
    }
    case 'append': {
      if (!Array.isArray(a.items)) throw new Error('append.items missing');
      let p = a.phase != null ? phaseOf(String(a.phase)) : P[P.length - 1];
      if (!p) { p = { name: String(a.phase ?? '작업'), tasks: [] }; P.push(p); }
      for (const s of a.items) p.tasks.push({ text: String(s), status: 'pending' });
      return P;
    }
    case 'rm':
      if (a.task != null) { P.forEach((p) => { p.tasks = p.tasks.filter((t) => t.text !== String(a.task)); }); return P; }
      if (a.phase != null) return P.filter((p) => p.name !== String(a.phase));
      return P;
    case 'view': return P;
    default: throw new Error(`unknown op ${(a as { op: string }).op}`);
  }
}

/** null = the session never used the todo tool. `raw` = last result text when arguments could not be parsed. */
export function replayTodos(items: Item[]): TodoState | null {
  let phases: Phase[] | null = null;
  let raw: string | null = null;
  let seen = false;
  for (const it of items) {
    if (it.type !== 'dynamicToolCall' || it.tool !== 'todo') continue;
    seen = true;
    const text = (it.contentItems ?? []).map((c) => c.text).filter(Boolean).join('\n');
    let args: unknown = it.arguments;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    if (!args || typeof args !== 'object' || typeof (args as { op?: unknown }).op !== 'string') { raw = text || raw; continue; }
    try { phases = apply(phases ?? [], args as TodoOp); raw = null; } catch { raw = text || raw; }
  }
  return seen ? { phases: phases ?? [], raw } : null;
}

export function todoProgress(t: TodoState | null) {
  if (!t || !t.phases.length) return null;
  const flat = t.phases.flatMap((p) => p.tasks.map((x) => ({ ...x, phase: p.name })));
  const live = flat.filter((x) => x.status !== 'abandoned');
  const cur = flat.find((x) => x.status === 'in_progress') ?? flat.find((x) => x.status === 'pending');
  return { done: live.filter((x) => x.status === 'completed').length, total: live.length, phase: cur?.phase ?? t.phases.at(-1)!.name, current: cur?.text ?? null };
}
