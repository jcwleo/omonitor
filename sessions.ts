// omo's saved sessions, read straight from their files (senpi docs/session-format.md). Listing them never loads a session
// into the omo host, so a session with a goal or open todos is not auto-continued by being looked at.
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type SessionMeta = {
  id: string; path: string; cwd: string; createdAt: number; name: string | null; preview: string;
  /** ms of the last message or compaction; loading a session appends metadata, which must not count as activity */
  talkedAt: number | null; mtimeMs: number;
};
type Scan = SessionMeta & { offset: number; size: number; header: boolean; bad: boolean };

export const textOf = (content: any): string => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
const PREVIEW_MAX = 400;
const STAMP = /"timestamp":"([^"]+)"/;

// Session files only grow, so each one is read once and then from where the last read ended. Entries are written with
// their type first, so a line's kind is known before it is parsed; only the few lines that matter are parsed at all.
export class SessionIndex {
  #scans = new Map<string, Scan>();
  #running: Promise<SessionMeta[]> | null = null;
  constructor(readonly dir: string) {}

  list(): Promise<SessionMeta[]> {
    return (this.#running ??= this.#scan().finally(() => { this.#running = null; }));
  }

  async pathOf(id: string): Promise<string | null> {
    const hit = () => [...this.#scans.values()].find((s) => s.header && s.id === id)?.path || null;
    return hit() || ((await this.list()), hit());
  }

  forget(path: string) { this.#scans.delete(path); }

  async #scan() {
    let dirs: string[] = [];
    try { dirs = await readdir(this.dir); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
    const files: string[] = [];
    await Promise.all(dirs.map(async (d) => {
      let names: string[];
      try { names = await readdir(join(this.dir, d)); } catch { return; } // not a folder
      for (const n of names) if (n.endsWith('.jsonl')) files.push(join(this.dir, d, n));
    }));
    const seen = new Set(files);
    for (const p of this.#scans.keys()) if (!seen.has(p)) this.#scans.delete(p);
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < files.length) {
        const f = files[next++];
        await this.#read(f).catch((e) => console.warn(`[sessions] ${f}: ${e?.message || e}`));
      }
    }));
    return [...this.#scans.values()].filter((s) => s.header).map(({ offset, size, header, bad, ...m }) => m);
  }

  async #read(path: string) {
    const st = await stat(path);
    let s = this.#scans.get(path);
    if (s && st.size === s.size && st.mtimeMs === s.mtimeMs) return;
    if (!s || st.size < s.offset) {
      s = { id: '', path, cwd: '', createdAt: 0, name: null, preview: '', talkedAt: null, mtimeMs: 0, offset: 0, size: 0, header: false, bad: false };
      this.#scans.set(path, s);
    }
    s.size = st.size;
    s.mtimeMs = st.mtimeMs;
    if (s.bad || st.size <= s.offset) return;
    const buf = new Uint8Array(await Bun.file(path).slice(s.offset, st.size).arrayBuffer());
    const end = buf.lastIndexOf(10) + 1; // complete lines only; the rest is read once it ends
    if (!end) return;
    s.offset += end;
    for (const line of new TextDecoder().decode(buf.subarray(0, end)).split('\n')) this.#line(s, line);
  }

  #line(s: Scan, line: string) {
    if (!line || s.bad) return;
    if (!s.header) {
      try {
        const h = JSON.parse(line);
        if (h?.type === 'session' && typeof h.id === 'string') Object.assign(s, { header: true, id: h.id, cwd: String(h.cwd || ''), createdAt: Date.parse(h.timestamp) || 0 });
      } catch {}
      if (!s.header) s.bad = true;
      return;
    }
    if (line.startsWith('{"type":"session_info"')) {
      try { const e = JSON.parse(line); s.name = typeof e.name === 'string' && e.name.trim() ? e.name : null; } catch {}
      return;
    }
    const message = line.startsWith('{"type":"message"');
    if (!message && !line.startsWith('{"type":"compaction"')) return;
    const at = Date.parse(line.match(STAMP)?.[1] || '');
    if (at) s.talkedAt = at;
    if (message && !s.preview && line.includes('"role":"user"')) {
      try { const e = JSON.parse(line); if (e.message?.role === 'user') s.preview = textOf(e.message.content).slice(0, PREVIEW_MAX); } catch {}
    }
  }
}

// The goal of a session, as omo's goal extension stores it beside the session files.
export type Goal = { objective: string; status: string; tokenBudget?: number; tokensUsed?: number };
export async function readGoal(sessionPath: string, id: string): Promise<Goal | null> {
  let d: any;
  try { d = JSON.parse(await readFile(join(dirname(sessionPath), 'extensions/goal', `${id}.json`), 'utf8')); }
  catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  const g = d?.goal;
  if (!g?.objective) return null;
  return { objective: String(g.objective), status: String(g.status || 'active'), ...(g.tokenBudget != null && { tokenBudget: g.tokenBudget }), ...(g.tokensUsed != null && { tokensUsed: g.tokensUsed }) };
}

// The omo host has no archive, so the dashboard keeps its own list of archived session ids.
export class ArchiveStore {
  #ids: Set<string> | null = null;
  constructor(readonly file: string) {}
  async ids(): Promise<Set<string>> {
    if (this.#ids) return this.#ids;
    try { this.#ids = new Set(JSON.parse(await readFile(this.file, 'utf8')).ids || []); }
    catch (e: any) { if (e?.code !== 'ENOENT') throw e; this.#ids = new Set(); }
    return this.#ids;
  }
  async set(id: string, archived: boolean) {
    const ids = await this.ids();
    if (archived === ids.has(id)) return;
    if (archived) ids.add(id); else ids.delete(id);
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(`${this.file}.tmp`, JSON.stringify({ ids: [...ids] }, null, 2));
    await rename(`${this.file}.tmp`, this.file);
  }
}

// A deleted session goes to omonitor's trash folder rather than away: its file, the files omo keeps beside it
// (<file>.jsonl.*, <file>-artifacts) and its goal.
export async function trashSession(path: string, id: string, trashDir: string) {
  const dir = dirname(path), base = basename(path, '.jsonl');
  const dest = join(trashDir, `${Date.now()}-${base}`);
  await mkdir(dest, { recursive: true });
  for (const n of await readdir(dir)) {
    if (n === `${base}.jsonl` || n.startsWith(`${base}.jsonl.`) || n === `${base}-artifacts`) await rename(join(dir, n), join(dest, n));
  }
  await rename(join(dir, 'extensions/goal', `${id}.json`), join(dest, `goal-${id}.json`)).catch((e) => { if (e?.code !== 'ENOENT') throw e; });
  return dest;
}
