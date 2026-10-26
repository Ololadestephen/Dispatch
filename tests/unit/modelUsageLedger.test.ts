import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '../../src/persistence/appDb';
import { ModelUsageLedger } from '../../src/persistence/modelUsageLedger';
import {
  DEFAULT_EXECUTION_LIMITS,
  MODEL_CALL_TOKEN_ALLOWANCE
} from '../../src/domain/executionLimits';

const input = {
  runId: 'run-test',
  orderId: 'DSP-1042',
  actorUserId: 'operator-test',
  model: 'test-model'
};

describe('Persistent model usage reservations', () => {
  let dir: string;
  const databases: AppDatabase[] = [];
  const open = (file: string) => {
    const database = new AppDatabase(file);
    databases.push(database);
    return database;
  };
  beforeEach(() => {
    fs.mkdirSync('tests/.tmp', { recursive: true });
    dir = fs.mkdtempSync(path.join('tests/.tmp', 'usage-'));
  });
  afterEach(() => {
    for (const database of databases.splice(0)) database.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps successful, failed and unfinished usage through demo reset and reopening', () => {
    const file = path.join(dir, 'app.sqlite');
    const database = open(file);
    const ledger = new ModelUsageLedger(database);
    expect(ledger.summary()).toMatchObject({
      calls: 0,
      chargedTokens: 0,
      pendingCalls: 0,
      failedCalls: 0
    });
    const success = ledger.reserve(input);
    ledger.finish(success, { status: 'succeeded', reportedTokens: 504 });
    const failed = ledger.reserve(input);
    ledger.finish(failed, { status: 'failed', errorCode: 'MODEL_OUTAGE' });
    ledger.reserve(input);
    database.clearDemoData();
    const reopened = new ModelUsageLedger(open(file));
    expect(reopened.summary()).toMatchObject({
      calls: 3,
      chargedTokens: 504 + 2 * MODEL_CALL_TOKEN_ALLOWANCE,
      pendingCalls: 1,
      failedCalls: 1
    });
    expect(reopened.summary().trackingStartedAtIso).toBe(ledger.summary().trackingStartedAtIso);
  });

  it('checks call limits atomically across database connections', () => {
    const file = path.join(dir, 'app.sqlite');
    const limits = { ...DEFAULT_EXECUTION_LIMITS, maxCalls: 1 };
    const first = new ModelUsageLedger(open(file), limits);
    const second = new ModelUsageLedger(open(file), limits);
    first.reserve(input);
    expect(() => second.reserve(input)).toThrow(/budget exhausted/i);
    expect(second.summary().calls).toBe(1);
  });

  it('checks the whole token allowance before permitting a call', () => {
    const ledger = new ModelUsageLedger(open(':memory:'), {
      ...DEFAULT_EXECUTION_LIMITS,
      maxTokens: MODEL_CALL_TOKEN_ALLOWANCE - 1
    });
    expect(() => ledger.reserve(input)).toThrow(/budget exhausted/i);
    expect(ledger.summary().calls).toBe(0);
  });

  it('allows known usage on failed outputs and never settles an attempt twice', () => {
    const ledger = new ModelUsageLedger(open(':memory:'));
    const attempt = ledger.reserve(input);
    ledger.finish(attempt, { status: 'failed', reportedTokens: 700, errorCode: 'MODEL_OUTAGE' });
    expect(ledger.summary()).toMatchObject({ calls: 1, failedCalls: 1, chargedTokens: 700 });
    expect(() => ledger.finish(attempt, { status: 'succeeded', reportedTokens: 0 })).toThrow();
    expect(ledger.summary().chargedTokens).toBe(700);
  });
});
