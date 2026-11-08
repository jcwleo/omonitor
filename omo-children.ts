// Task-owned conversation files stay outside SessionIndex: viewing a child must never load it or add it to the board.
import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

type ChildRecord = {
  readonly taskId: string;
  readonly parentId: string;
  readonly childId: string;
  readonly path: string;
  readonly storage: string;
  readonly status: string;
};
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

export class OmoChildren {
  constructor(readonly projects: string) {}

  async *records(): AsyncGenerator<ChildRecord> {
    let root: string;
    try { root = await realpath(this.projects); }
    catch (error) { if (missing(error)) return; throw error; }
    for await (const name of new Bun.Glob('*/senpi-task/tasks/st_*.json').scan(root)) {
      const path = join(root, name);
      let value: unknown;
      try {
        // Reject symlinked project directories and task records, not just caller-supplied traversal.
        if (await realpath(path) !== path) continue;
        value = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) { if (missing(error) || error instanceof SyntaxError) continue; throw error; }
      if (!object(value) || typeof value.task_id !== 'string' || typeof value.parent_session_id !== 'string' || typeof value.child_session_id !== 'string' || !object(value.host_session) || typeof value.host_session.session_path !== 'string') continue;
      if (!/^st_[a-zA-Z0-9_-]+$/.test(value.task_id) || name.split('/').at(-1) !== `${value.task_id}.json`) continue;
      yield { taskId: value.task_id, parentId: value.parent_session_id, childId: value.child_session_id, path: value.host_session.session_path, storage: dirname(dirname(path)), status: typeof value.status === 'string' ? value.status : '' };
    }
  }

  async childPath(record: ChildRecord): Promise<string | null> {
    const path = resolve(record.path);
    const sessions = join(record.storage, 'children', record.taskId, 'sessions');
    const inside = relative(sessions, path);
    if (!inside || inside.startsWith('../') || inside.startsWith('/') || !path.endsWith('.jsonl')) return null;
    try {
      if (await realpath(path) !== path) return null;
      // The session header, rather than the filename, owns its ID (omo can rename a child after creating its file).
      const first = (await Bun.file(path).slice(0, 8192).text()).split('\n')[0];
      if (!first) return null;
      const header: unknown = JSON.parse(first);
      return object(header) && header.type === 'session' && header.id === record.childId ? path : null;
    } catch (error) { if (missing(error) || error instanceof SyntaxError) return null; throw error; }
  }

  async pathOf(id: string): Promise<string | null> {
    for await (const record of this.records()) if (record.childId === id) {
      const path = await this.childPath(record);
      if (path) return path;
    }
    return null;
  }

  async forParent(id: string): Promise<ReadonlyMap<string, ChildRecord>> {
    const children = new Map<string, ChildRecord>();
    for await (const record of this.records()) if (record.parentId === id && await this.childPath(record)) children.set(record.taskId, record);
    return children;
  }
}
