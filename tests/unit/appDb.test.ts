import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { AppDatabase } from '../../src/persistence/appDb';

it('upgrades a manager-only database without changing history, usage or integrity guards', () => {
  fs.mkdirSync(path.join(process.cwd(), 'tests/.tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(process.cwd(), 'tests/.tmp/approval-migration-'));
  const file = path.join(dir, 'app.sqlite');
  let database = new DatabaseSync(file);
  try {
    database.exec(
      'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at_iso TEXT NOT NULL)'
    );
    for (const name of [
      '001_initial_schema.sql',
      '002_integrity_guards.sql',
      '003_model_usage.sql'
    ]) {
      database.exec(fs.readFileSync(path.join('db/migrations', name), 'utf8'));
      database
        .prepare('INSERT INTO schema_migrations VALUES (?, ?)')
        .run(name, '2026-10-25T00:00:00Z');
    }
    database.exec(`
      INSERT INTO receipt_versions VALUES ('RCP-HISTORY', 1, 'DSP-1042', 'awaiting_approval', 'live', '{"historical":true}', '2026-10-25T00:00:00Z');
      INSERT INTO approvals VALUES ('APR-HISTORY', 'RCP-HISTORY', 1, 'manager-1', 'Manager', 'manager', 'legacy-key', '2026-10-25T00:00:00Z');
      INSERT INTO model_call_reservations VALUES ('ATT-HISTORY', 'RUN-HISTORY', 'DSP-1042', 'operator-1', 'model', 16384, '2026-10-25T00:00:00Z');
      INSERT INTO model_call_outcomes VALUES ('ATT-HISTORY', 'succeeded', 826, NULL, '2026-10-25T00:00:01Z');
    `);
    const preservedTables = [
      'receipt_versions',
      'approvals',
      'model_usage_metadata',
      'model_call_reservations',
      'model_call_outcomes'
    ];
    const before = preservedTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all());
    database.close();
    database = new AppDatabase(file).db;
    expect(
      preservedTables.map((table) => database.prepare(`SELECT * FROM ${table}`).all())
    ).toEqual(before);
    expect(database.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
    expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const insert = database.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run(
      'APR-OPERATOR',
      'RCP-HISTORY',
      2,
      'operator-1',
      'Operator',
      'operator',
      'new-key',
      '2026-10-26T00:00:00Z'
    );
    expect(() =>
      insert.run(
        'APR-DUPLICATE',
        'RCP-HISTORY',
        2,
        'manager-1',
        'Manager',
        'manager',
        'other-key',
        'now'
      )
    ).toThrow(/UNIQUE/);
    expect(() =>
      insert.run(
        'APR-INVALID',
        'RCP-HISTORY',
        3,
        'unknown',
        'Unknown',
        'external',
        'other-key',
        'now'
      )
    ).toThrow(/CHECK/);
    expect(() => database.exec("UPDATE receipt_versions SET status = 'confirmed'")).toThrow(
      /immutable/
    );
    expect(() => database.exec('DELETE FROM model_call_reservations')).toThrow(
      /survives demo reset/
    );

    database.close();
    database = new AppDatabase(file).db;
    expect(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get()).toEqual({
      count: 4
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({ count: 2 });
  } finally {
    if (database.isOpen) database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
