import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RecoveryService } from '../../src/application/recoveryService';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import type { DecisionReceipt } from '../../src/domain/receipt';
import { DEMO_ORDER, SEEDED_USERS } from '../../src/demo/seedData';
import { AppDatabase } from '../../src/persistence/appDb';
import { RecoveryStore } from '../../src/persistence/recoveryStore';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { runTmp } from '../support/runRoot';

const tempFiles: string[] = [];

function receipt(orderId: string, deadline = DEMO_ORDER.deliveryDeadlineIso): DecisionReceipt {
  const latestEligible = new Date(new Date(deadline).getTime() - 60 * 60_000).toISOString();
  return {
    receiptId: `RCP-${orderId}-01`,
    version: 1,
    orderId,
    scenarioClockIso: FROZEN_SCENARIO_TIME_ISO,
    createdAtIso: FROZEN_SCENARIO_TIME_ISO,
    status: 'awaiting_approval',
    executionMode: 'live',
    sourceRevisions: [
      {
        sourceType: 'orders',
        recordId: orderId,
        revisionId: 'REV-ORD-01',
        snapshotHash: 'a'.repeat(64)
      },
      {
        sourceType: 'inventory',
        recordId: 'WHS-LOS-01',
        revisionId: 'REV-INV-01',
        snapshotHash: 'b'.repeat(64)
      },
      {
        sourceType: 'backup_listings',
        recordId: 'BCK-LST-402',
        revisionId: 'REV-BCK-01',
        snapshotHash: 'c'.repeat(64)
      }
    ],
    investigationSteps: [],
    candidateRemedy: {
      listingId: 'BCK-LST-402',
      revisionId: 'REV-BCK-01',
      supplierName: 'Lekki Party Supplies Ltd',
      sku: 'CHR-GOLD-CHIAVARI',
      availableQuantity: 60,
      advertisedQuantity: 60,
      reservedQuantity: 0,
      reservedByOrders: [],
      statedDeliveryArrivalIso: '2026-10-24T07:00:00+01:00',
      costKobo: 9_000_000,
      isConfirmedReservation: false,
      isEligibleByDeadline: true
    },
    calculations: {
      sku: 'CHR-GOLD-CHIAVARI',
      requiredQuantity: 120,
      physicallyPresent: 80,
      damaged: 20,
      activeAllocations: 0,
      usableAvailable: 60,
      eligibleIncoming: 0,
      shortfall: 60,
      hasShortage: true
    },
    timing: {
      deliveryDeadlineIso: deadline,
      transportBufferMinutes: 60,
      latestEligibleArrivalIso: latestEligible,
      supplierExpectedArrivalIso: '2026-10-26T09:00:00+01:00'
    },
    financial: {
      currency: 'NGN',
      extraCostKobo: 9_000_000,
      approvalThresholdKobo: 5_000_000,
      requiresManagerApproval: true,
      policyExplanation: 'NGN 90,000 exceeds NGN 50,000 limit'
    },
    agentFindings: {
      headline: '60 chairs short for Saturday',
      extractedQuotes: [],
      ignoredInstructions: [],
      uncertainties: []
    }
  };
}

const approve = (
  service: RecoveryService,
  receiptId: string,
  expectedVersion: number,
  idempotencyKey: string
) =>
  service.approvePlan({
    receiptId,
    expectedVersion,
    actor: SEEDED_USERS.manager,
    idempotencyKey
  });

afterEach(() => {
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
});

describe('shared backup-lot reservations', () => {
  it('backfills an approved legacy plan once without changing its saved receipt', () => {
    const file = runTmp('reservation_backfill.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    tempFiles.push(file, file + '-wal', file + '-shm');
    const legacy = new DatabaseSync(file);
    legacy.exec(
      'CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at_iso TEXT NOT NULL)'
    );
    for (const name of fs
      .readdirSync('db/migrations')
      .filter((name) => /^00[1-4]_/.test(name))
      .sort()) {
      legacy.exec(fs.readFileSync(path.join('db/migrations', name), 'utf8'));
      legacy
        .prepare('INSERT INTO schema_migrations VALUES (?,?)')
        .run(name, FROZEN_SCENARIO_TIME_ISO);
    }
    const approved = { ...receipt('DSP-1042'), version: 2, status: 'awaiting_confirmation' };
    const payload = JSON.stringify(approved);
    legacy
      .prepare('INSERT INTO receipt_versions VALUES (?,?,?,?,?,?,?)')
      .run(
        approved.receiptId,
        2,
        'DSP-1042',
        approved.status,
        'live',
        payload,
        FROZEN_SCENARIO_TIME_ISO
      );
    legacy.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const upgraded = new AppDatabase(file);
      try {
        expect(upgraded.db.prepare('SELECT payload_json FROM receipt_versions').get()).toEqual({
          payload_json: payload
        });
        expect(
          upgraded.db
            .prepare('SELECT quantity,status,idempotency_key FROM backup_reservations')
            .all()
        ).toEqual([{ quantity: 60, status: 'active', idempotency_key: 'migration-005' }]);
        expect(upgraded.db.prepare('PRAGMA integrity_check').get()).toEqual({
          integrity_check: 'ok'
        });
      } finally {
        upgraded.db.close();
      }
    }
  });

  it('allows exactly one winner when two SQLite connections race at transaction entry', async () => {
    const file = runTmp('reservation_race.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    tempFiles.push(file, file + '-wal', file + '-shm');
    const database = new AppDatabase(file);
    const service = new RecoveryService(
      new FrozenClock(FROZEN_SCENARIO_TIME_ISO),
      new RecoveryStore(database)
    );
    service.saveReceipt(receipt('DSP-1042'));
    service.saveReceipt(receipt('DSP-1043'));
    database.db.close();
    const gate = new SharedArrayBuffer(4);
    const code = `
      require('tsx/cjs/api').register();
      const {parentPort,workerData}=require('node:worker_threads');
      const {AppDatabase}=require(workerData.root+'/src/persistence/appDb.ts');
      const {RecoveryStore}=require(workerData.root+'/src/persistence/recoveryStore.ts');
      const {RecoveryService}=require(workerData.root+'/src/application/recoveryService.ts');
      const {FrozenClock,FROZEN_SCENARIO_TIME_ISO}=require(workerData.root+'/src/domain/clock.ts');
      const {SEEDED_USERS}=require(workerData.root+'/src/demo/seedData.ts');
      class RacingStore extends RecoveryStore {
        transaction(work) {
          parentPort.postMessage({ready:true});
          if(Atomics.wait(new Int32Array(workerData.gate),0,0,5000)==='timed-out') throw new Error('Race barrier timed out');
          return super.transaction(work);
        }
      }
      const db=new AppDatabase(workerData.file);
      const service=new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO),new RacingStore(db));
      try {
        service.approvePlan({receiptId:'RCP-'+workerData.orderId+'-01',expectedVersion:1,
          actor:SEEDED_USERS.manager,idempotencyKey:'race-'+workerData.orderId});
        parentPort.postMessage({ok:true});
      } catch(error) {parentPort.postMessage({ok:false,code:error.code,message:error.message});}
      finally {db.db.close();}
    `;
    const contenders = ['DSP-1042', 'DSP-1043'].map((orderId) => {
      const worker = new Worker(code, {
        eval: true,
        workerData: { root: process.cwd(), file, orderId, gate }
      });
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        worker.once('error', reject);
      });
      const result = new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
        worker.on('message', (message: { ready?: boolean; ok: boolean; code?: string }) => {
          if (message.ready) readyResolve();
          else resolve(message);
        });
        worker.once('error', reject);
      });
      return { worker, ready, result };
    });
    try {
      await Promise.all(contenders.map((contender) => contender.ready));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 2);
      const results = await Promise.all(contenders.map((contender) => contender.result));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)?.code).toBe('BACKUP_STOCK_TAKEN');
      const reopened = new AppDatabase(file);
      try {
        expect(
          reopened.db
            .prepare(
              "SELECT COUNT(*) AS count, SUM(quantity) AS quantity FROM backup_reservations WHERE status = 'active'"
            )
            .get()
        ).toEqual({ count: 1, quantity: 60 });
        expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({
          count: 1
        });
      } finally {
        reopened.db.close();
      }
    } finally {
      await Promise.all(contenders.map((contender) => contender.worker.terminate()));
    }
  });

  it('lets exactly one approval win when two connections race on the same receipt version', async () => {
    const file = runTmp('same_receipt_race.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    tempFiles.push(file, file + '-wal', file + '-shm');
    const database = new AppDatabase(file);
    const service = new RecoveryService(
      new FrozenClock(FROZEN_SCENARIO_TIME_ISO),
      new RecoveryStore(database)
    );
    service.saveReceipt(receipt('DSP-1042'));
    database.db.close();

    const gate = new SharedArrayBuffer(4);
    const code = `
      require('tsx/cjs/api').register();
      const {parentPort,workerData}=require('node:worker_threads');
      const {AppDatabase}=require(workerData.root+'/src/persistence/appDb.ts');
      const {RecoveryStore}=require(workerData.root+'/src/persistence/recoveryStore.ts');
      const {RecoveryService}=require(workerData.root+'/src/application/recoveryService.ts');
      const {FrozenClock,FROZEN_SCENARIO_TIME_ISO}=require(workerData.root+'/src/domain/clock.ts');
      const {SEEDED_USERS}=require(workerData.root+'/src/demo/seedData.ts');
      class RacingStore extends RecoveryStore {
        transaction(work) {
          parentPort.postMessage({ready:true});
          if(Atomics.wait(new Int32Array(workerData.gate),0,0,5000)==='timed-out') throw new Error('Race barrier timed out');
          return super.transaction(work);
        }
      }
      const db=new AppDatabase(workerData.file);
      const service=new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO),new RacingStore(db));
      try {
        service.approvePlan({receiptId:'RCP-DSP-1042-01',expectedVersion:1,
          actor:SEEDED_USERS.manager,idempotencyKey:'same-receipt-'+workerData.worker});
        parentPort.postMessage({ok:true});
      } catch(error) {parentPort.postMessage({ok:false,code:error.code,message:error.message});}
      finally {db.db.close();}
    `;
    const contenders = ['a', 'b'].map((workerId) => {
      const worker = new Worker(code, {
        eval: true,
        workerData: { root: process.cwd(), file, worker: workerId, gate }
      });
      let readyResolve!: () => void;
      const ready = new Promise<void>((resolve, reject) => {
        readyResolve = resolve;
        worker.once('error', reject);
      });
      const result = new Promise<{ ok: boolean; code?: string; message?: string }>(
        (resolve, reject) => {
          worker.on('message', (message: { ready?: boolean; ok: boolean; code?: string }) => {
            if (message.ready) readyResolve();
            else resolve(message);
          });
          worker.once('error', reject);
        }
      );
      return { worker, ready, result };
    });
    try {
      await Promise.all(contenders.map((contender) => contender.ready));
      Atomics.store(new Int32Array(gate), 0, 1);
      Atomics.notify(new Int32Array(gate), 0, 2);
      const results = await Promise.all(contenders.map((contender) => contender.result));
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const loser = results.find((result) => !result.ok);
      expect(loser?.code).toBe('VERSION_CONFLICT');
      expect(loser?.message).toContain('changed while approving');

      const reopened = new AppDatabase(file);
      try {
        expect(reopened.db.prepare('SELECT COUNT(*) AS count FROM approvals').get()).toEqual({
          count: 1
        });
        expect(
          reopened.db
            .prepare('SELECT version FROM receipt_versions WHERE receipt_id = ? ORDER BY version')
            .all('RCP-DSP-1042-01')
        ).toEqual([{ version: 1 }, { version: 2 }]);
        expect(
          reopened.db
            .prepare("SELECT COUNT(*) AS count FROM backup_reservations WHERE status = 'active'")
            .get()
        ).toEqual({ count: 1 });
      } finally {
        reopened.db.close();
      }
    } finally {
      await Promise.all(contenders.map((contender) => contender.worker.terminate()));
    }
  });

  it('lets the first approval reserve the lot and sends the competing plan back for review', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));
    service.saveReceipt(receipt('DSP-1043', '2026-10-24T10:00:00+01:00'));

    const first = approve(service, 'RCP-DSP-1042-01', 1, 'reserve-first');

    expect(first.reservation).toMatchObject({
      orderId: 'DSP-1042',
      quantity: 60,
      status: 'active',
      receiptVersion: 2
    });
    expect(service.listActiveReservations()).toHaveLength(1);
    expect(service.getBackupAvailability('BCK-LST-402', 60)).toMatchObject({
      advertisedQuantity: 60,
      reservedQuantity: 60,
      availableQuantity: 0
    });

    const loser = service.getReceipt('RCP-DSP-1043-01')!;
    expect(loser.status).toBe('stale');
    expect(loser.version).toBe(2);
    expect(loser.invalidatedReason).toBe('backup_conflict');
    expect(loser.agentFindings.uncertainties).toContain(
      'Backup stock taken by DSP-1042 — re-plan.'
    );

    const audit = service.getAuditEvents('RCP-DSP-1043-01');
    expect(audit.at(-1)).toMatchObject({
      eventType: 'plan_invalidated_backup_conflict',
      receiptVersion: 2
    });
  });

  it('rejects a second approval with a typed error when the lot is already taken', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));
    approve(service, 'RCP-DSP-1042-01', 1, 'reserve-before-late-plan');

    // A receipt saved after the winner committed can still cite the old advertised quantity.
    service.saveReceipt(receipt('DSP-1048'));
    expect(() => approve(service, 'RCP-DSP-1048-01', 1, 'late-plan')).toThrow(
      expect.objectContaining({
        code: 'BACKUP_STOCK_TAKEN',
        message: 'Backup stock taken by DSP-1042 — re-plan.'
      })
    );

    expect(service.getReceiptHistory('RCP-DSP-1048-01')).toHaveLength(1);
    expect(service.getApproval('RCP-DSP-1048-01')).toBeUndefined();
    expect(service.getTasks('RCP-DSP-1048-01')).toEqual([]);
    expect(service.listActiveReservations()).toHaveLength(1);
  });

  it('returns the committed approval on an idempotent retry without reserving twice', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));

    const first = approve(service, 'RCP-DSP-1042-01', 1, 'reserve-replay');
    const replay = approve(service, 'RCP-DSP-1042-01', 1, 'reserve-replay');

    expect(replay.isIdempotentReplay).toBe(true);
    expect(replay.reservation.reservationId).toBe(first.reservation.reservationId);
    expect(service.listActiveReservations()).toHaveLength(1);
    expect(
      service.database.db.prepare('SELECT COUNT(*) AS count FROM backup_reservations').get()
    ).toEqual({ count: 1 });
  });

  it('releases a superseded plan and keeps a cancelled plan replay-safe', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));
    approve(service, 'RCP-DSP-1042-01', 1, 'hold-before-supersession');
    service.saveReceipt({ ...receipt('DSP-1042'), version: 3 });
    expect(service.listActiveReservations()).toHaveLength(0);
    expect(service.listReservations()[0]?.releaseReason).toBe('superseded');
    approve(service, 'RCP-DSP-1042-01', 3, 'hold-before-cancel');
    const command = {
      receiptId: 'RCP-DSP-1042-01',
      expectedVersion: 4,
      actor: SEEDED_USERS.manager,
      idempotencyKey: 'cancel-once',
      reason: 'No longer needed'
    };
    expect(() => service.cancelPlan({ ...command, actor: SEEDED_USERS.operator })).toThrow(
      expect.objectContaining({ code: 'FORBIDDEN_ROLE' })
    );
    const cancelled = service.cancelPlan(command);
    expect(cancelled.receipt.status).toBe('rejected');
    expect(cancelled.receipt.version).toBe(5);
    expect(service.listActiveReservations()).toHaveLength(0);
    expect(service.cancelPlan(command)).toMatchObject({
      isIdempotentReplay: true,
      receipt: { version: 5 }
    });
    expect(
      service.getAuditEvents().filter((event) => event.eventType === 'plan_cancelled')
    ).toHaveLength(1);
    expect(service.getReceiptHistory('RCP-DSP-1042-01')).toHaveLength(5);
  });

  it('releases a stale plan’s hold and allows a fresh plan to reserve the lot', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));
    approve(service, 'RCP-DSP-1042-01', 1, 'reserve-release');

    const stale = service.invalidatePlanOnSourceChange('RCP-DSP-1042-01', 'Inventory revised');
    expect(stale.status).toBe('stale');
    expect(service.listActiveReservations()).toHaveLength(0);
    expect(
      service.database.db.prepare('SELECT status, release_reason FROM backup_reservations').get()
    ).toEqual({ status: 'released', release_reason: 'source_change' });

    service.saveReceipt({
      ...receipt('DSP-1042'),
      version: stale.version + 1,
      status: 'awaiting_approval'
    });
    const approvedAgain = approve(service, 'RCP-DSP-1042-01', stale.version + 1, 'reserve-again');
    expect(approvedAgain.reservation.receiptVersion).toBe(stale.version + 2);
    expect(service.listActiveReservations()).toHaveLength(1);
    expect(service.getBackupAvailability('BCK-LST-402', 60).availableQuantity).toBe(0);
  });

  it('keeps the reservation when the supplier confirmation arrives', () => {
    const service = new RecoveryService(new FrozenClock(FROZEN_SCENARIO_TIME_ISO));
    service.saveReceipt(receipt('DSP-1042'));
    approve(service, 'RCP-DSP-1042-01', 1, 'reserve-confirm');

    service.recordSupplierConfirmation({
      receiptId: 'RCP-DSP-1042-01',
      expectedVersion: 2,
      actor: SEEDED_USERS.operator,
      idempotencyKey: 'confirm-keeps-hold',
      confirmation: {
        supplierName: 'Lekki Party Supplies Ltd',
        sku: 'CHR-GOLD-CHIAVARI',
        confirmedQuantity: 60,
        confirmedArrivalIso: '2026-10-24T07:00:00+01:00',
        confirmationReference: 'CONF-HOLD-01',
        evidenceExcerpt: 'Simulated: 60 chairs arrive Saturday 07:00 WAT.'
      }
    });

    expect(service.getReceipt('RCP-DSP-1042-01')?.status).toBe('confirmed');
    expect(service.listActiveReservations()).toHaveLength(1);
  });

  it('persists reservations across a database reopen', () => {
    const file = runTmp('reservation_persistence.sqlite');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.rmSync(file, { force: true });
    tempFiles.push(file);

    const first = new AppDatabase(file);
    const firstService = new RecoveryService(
      new FrozenClock(FROZEN_SCENARIO_TIME_ISO),
      new RecoveryStore(first)
    );
    firstService.saveReceipt(receipt('DSP-1042'));
    approve(firstService, 'RCP-DSP-1042-01', 1, 'reserve-persist');
    first.db.close();

    const second = new AppDatabase(file);
    const secondService = new RecoveryService(
      new FrozenClock(FROZEN_SCENARIO_TIME_ISO),
      new RecoveryStore(second)
    );
    expect(secondService.listActiveReservations()).toMatchObject([
      { orderId: 'DSP-1042', quantity: 60, status: 'active' }
    ]);
    expect(secondService.getBackupAvailability('BCK-LST-402', 60)).toMatchObject({
      reservedQuantity: 60,
      availableQuantity: 0
    });
    second.db.close();
  });
});
