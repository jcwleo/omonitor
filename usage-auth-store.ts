import { Database } from 'bun:sqlite';
import { chmod, mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { credentialSchema, UsageAuthError } from './usage-oauth.ts';
import type { UsageCredential } from './usage-oauth.ts';
import type { UsageProvider } from './src/protocol.ts';

type Row = { credential: string | null; revision: number; lease: string | null; lease_until: number };
export class UsageAuthStore {
  private constructor(private readonly db: Database) {}
  static async open(directory: string) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = join(directory, 'accounts.sqlite');
    const handle = await open(file, 'a', 0o600);
    await handle.close();
    await chmod(file, 0o600);
    const db = new Database(file);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA secure_delete=ON');
    db.exec(`CREATE TABLE IF NOT EXISTS accounts (
      provider TEXT PRIMARY KEY, credential TEXT, revision INTEGER NOT NULL DEFAULT 0,
      lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    )`);
    for (const provider of ['claude', 'chatgpt']) db.query('INSERT OR IGNORE INTO accounts(provider) VALUES (?)').run(provider);
    return new UsageAuthStore(db);
  }
  read(provider: UsageProvider) {
    const row = this.db.query<Row, [string]>('SELECT credential, revision, lease, lease_until FROM accounts WHERE provider=?').get(provider);
    if (!row) throw new UsageAuthError('구독 인증 저장소를 읽지 못했습니다', 500);
    try {
      return { ...row, credential: row.credential ? credentialSchema.parse(JSON.parse(row.credential)) : null };
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) throw new UsageAuthError('저장된 구독 인증 정보를 읽지 못했습니다', 500);
      throw error;
    }
  }
  claim(provider: UsageProvider, revision: number) {
    const lease = crypto.randomUUID();
    // The lease outlives the bounded token request, and expires after a crashed process.
    const result = this.db.query(`UPDATE accounts SET lease=?, lease_until=?
      WHERE provider=? AND revision=? AND lease_until<=?`).run(lease, Date.now() + 60000, provider, revision, Date.now());
    if (!result.changes) throw new UsageAuthError('다른 로그인 또는 인증 갱신이 진행 중입니다. 잠시 후 다시 시도하세요', 409);
    return lease;
  }
  save(provider: UsageProvider, lease: string, credential: UsageCredential) {
    const result = this.db.query(`UPDATE accounts SET credential=?, revision=revision+1, lease=NULL, lease_until=0
      WHERE provider=? AND lease=?`).run(JSON.stringify(credential), provider, lease);
    if (!result.changes) throw new UsageAuthError('로그인 상태가 변경됐습니다. 다시 로그인하세요', 409);
  }
  release(provider: UsageProvider, lease: string) {
    this.db.query('UPDATE accounts SET lease=NULL, lease_until=0 WHERE provider=? AND lease=?').run(provider, lease);
  }
  logout(provider: UsageProvider) {
    this.db.query('UPDATE accounts SET credential=NULL, revision=revision+1, lease=NULL, lease_until=0 WHERE provider=?').run(provider);
  }
  close() { this.db.close(); }
}
