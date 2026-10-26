import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { UserRole, UserSession } from '../domain/policy';
import { SEEDED_USERS } from '../demo/seedData';

const MIGRATIONS_DIR = path.join(process.cwd(), 'db/migrations');

/**
 * Application database: node:sqlite with ordered, recorded migrations.
 * Deviation from ARCHITECTURE.md (PostgreSQL): SQLite keeps the demo a single local process
 * with no server to install; every mutation still runs in one transaction.
 */
export class AppDatabase {
  public readonly db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(
      'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'
    );
    this.runMigrations();
  }

  /** Applies each db/migrations/NNN_*.sql file once, in name order, recording it in schema_migrations. */
  private runMigrations(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at_iso TEXT NOT NULL);'
    );
    const applied = new Set(
      (this.db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
        (r) => r.name
      )
    );
    const pending = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f) && !applied.has(f))
      .sort();
    for (const name of pending) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      this.runInTransaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO schema_migrations (name, applied_at_iso) VALUES (?, ?)')
          .run(name, new Date().toISOString());
      });
    }
  }

  public runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  /** Demo reset: clears application history. Sessions survive so the browser keeps its role. */
  public clearDemoData(): void {
    this.runInTransaction(() => {
      this.db.exec(`
        DELETE FROM audit_events;
        DELETE FROM idempotency_records;
        DELETE FROM supplier_confirmations;
        DELETE FROM supplier_request_drafts;
        DELETE FROM recovery_tasks;
        DELETE FROM approvals;
        DELETE FROM receipt_versions;
      `);
    });
  }

  /** Returns the user for a server-issued session, or undefined for an unknown id. */
  public findSessionUser(sessionId: string): UserSession | undefined {
    const row = this.db
      .prepare('SELECT user_id, user_name, role FROM user_sessions WHERE session_id = ?')
      .get(sessionId) as { user_id: string; user_name: string; role: UserRole } | undefined;
    return row ? { userId: row.user_id, name: row.user_name, role: row.role } : undefined;
  }

  /** Issues a new random session. New sessions start with the least-privileged role. */
  public createSession(): { sessionId: string; user: UserSession } {
    const sessionId = `sess-${crypto.randomUUID()}`;
    return { sessionId, user: this.setSessionRole(sessionId, 'operator') };
  }

  public setSessionRole(sessionId: string, role: UserRole): UserSession {
    const seeded = SEEDED_USERS[role];
    this.db
      .prepare(
        `INSERT INTO user_sessions (session_id, user_id, user_name, role, updated_at_iso)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           user_id = excluded.user_id,
           user_name = excluded.user_name,
           role = excluded.role,
           updated_at_iso = excluded.updated_at_iso;`
      )
      .run(sessionId, seeded.userId, seeded.name, seeded.role, new Date().toISOString());
    return seeded;
  }
}
