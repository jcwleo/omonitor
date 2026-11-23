// Unread notifications shared by every device: thread id → the id of its latest unread notification. A session keeps
// one entry, as the service worker keeps one notification per session. Every change raises the revision, and a new
// notification takes the new revision as its id, so ids never repeat and clients can drop an older snapshot. The state
// lives in ~/.omonitor/unread.json and survives restarts.
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

export type UnreadSnapshot = { revision: number; unread: Record<string, number> };

const stored = z.object({
  revision: z.number().int().nonnegative(),
  unread: z.record(z.string().min(1), z.number().int().positive()),
});

export class UnreadStore {
  #state: UnreadSnapshot | null = null;
  // Every read and change runs in order, so concurrent requests see each other's changes and the file is written by
  // one change at a time.
  #queue: Promise<unknown> = Promise.resolve();
  #listeners = new Set<(s: UnreadSnapshot) => void>();
  constructor(private readonly file: string) {}

  onChange(fn: (s: UnreadSnapshot) => void) {
    this.#listeners.add(fn);
    return () => { this.#listeners.delete(fn); };
  }

  snapshot() { return this.#run(async () => copy(await this.#load())); }

  add(threadId: string) {
    return this.#change((unread, revision) => { unread[threadId] = revision; return true; })
      .then((s) => ({ notificationId: s.revision, revision: s.revision, badgeCount: Object.keys(s.unread).length }));
  }

  // Reading a notification clears it only while it is still the session's latest, so a newer one stays unread.
  read(threadId: string, notificationId: number) {
    return this.#change((unread) => {
      if (unread[threadId] !== notificationId) return false;
      delete unread[threadId];
      return true;
    });
  }

  forget(threadId: string) {
    return this.#change((unread) => {
      if (!(threadId in unread)) return false;
      delete unread[threadId];
      return true;
    });
  }

  #run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.#queue.then(fn);
    this.#queue = p.then(() => {}, () => {});
    return p;
  }

  // The edit works on a copy that becomes the state only once it is on disk; an edit that changes nothing keeps the
  // revision.
  #change(edit: (unread: Record<string, number>, revision: number) => boolean) {
    return this.#run(async () => {
      const cur = await this.#load();
      const next = { revision: cur.revision + 1, unread: { ...cur.unread } };
      if (!edit(next.unread, next.revision)) return copy(cur);
      await this.#save(next);
      this.#state = next;
      for (const fn of this.#listeners) {
        try { fn(copy(next)); } catch (e: any) { console.error('[push] 읽지 않은 알림 변경을 알리지 못했습니다:', e?.message || e); }
      }
      return copy(next);
    });
  }

  // A damaged file is reported, not reset: starting over would reuse notification ids.
  async #load(): Promise<UnreadSnapshot> {
    if (this.#state) return this.#state;
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return (this.#state = { revision: 0, unread: {} });
    }
    const parsed = stored.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`읽지 않은 알림 파일이 올바르지 않습니다: ${this.file}`);
    return (this.#state = parsed.data);
  }

  // Flushed to a temporary file and renamed over the old one, so a crash leaves either the old or the new state.
  async #save(s: UnreadSnapshot) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fh = await open(tmp, 'w', 0o600);
    try {
      await fh.writeFile(JSON.stringify(s));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, this.file);
  }
}

const copy = (s: UnreadSnapshot): UnreadSnapshot => ({ revision: s.revision, unread: { ...s.unread } });
