import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, nameSimilarity } from '@meterless/world-model-reference';
import { InvestigationService } from '../../src/application/investigationService';
import { RecoveryService } from '../../src/application/recoveryService';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import { createDispatchScout } from '../../src/integrations/meterless/dispatchScout';
import { WorldModelService } from '../../src/integrations/meterless/worldModel';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { SourceGateway } from '../../src/integrations/sources';
import { LocalFileStore } from '../../src/integrations/sources/localFiles';
import { DEMO_SEED } from '../../src/server/stateStore';
import { DEMO_WAREHOUSE, SEEDED_USERS } from '../../src/demo/seedData';
import { executeLookupContract } from '../../src/application/lookupPlan';
import { answerWorldContext } from '../../src/application/worldModelContext';
import { runTmp } from '../support/runRoot';

const dataDir = runTmp('world_model_workspace');

describe('Meterless World Model integration', () => {
  let sources: SourceGateway;
  let recovery: RecoveryService;
  let world: WorldModelService;
  let investigation: InvestigationService;
  let clock: FrozenClock;

  beforeEach(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    const store = new LocalFileStore(dataDir);
    clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);
    recovery = new RecoveryService(clock);
    sources = new SourceGateway(store, store, recovery);
    await sources.seed(DEMO_SEED);
    world = new WorldModelService({
      dataDir,
      clock: () => new Date(FROZEN_SCENARIO_TIME_ISO)
    });
    investigation = new InvestigationService(
      sources,
      NvidiaExtractionAgent.createWithMock(),
      recovery,
      clock,
      createDispatchScout({ dataDir, modelId: 'mock-world-model-test-only' }),
      undefined,
      { worldModel: world }
    );
  });

  afterEach(() => {
    recovery.database.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const snapshot = (orderId: string) =>
    sources.fetchEvidenceSnapshot(orderId, FROZEN_SCENARIO_TIME_ISO);

  it('uses the vendored resolver bands: 0.8333 is review, 0.125 is a clear non-match', () => {
    const review = nameSimilarity('Lekki Party Supplies Ltd', 'Lekki Party Supplies');
    expect(review).toBeCloseTo(0.8333, 4);
    expect(decide(review)).toBe('review');
    expect(decide(0.82)).toBe('review');
    expect(decide(0.85)).toBe('auto-merge');

    const distinct = nameSimilarity('Surulere Chair Bank', 'Lekki Party Supplies Ltd');
    expect(distinct).toBeCloseTo(0.125, 4);
    expect(decide(distinct)).toBe('new');
  });

  it('ingests every lookup once; replaying the same revisions appends nothing', async () => {
    const first = await world.ingestSnapshot(await snapshot('DSP-1042'), []);
    expect(first.processed).toBeGreaterThan(0);
    expect(first.reference.eventId).toMatch(/^evt_\d+$/);
    expect(first.reference.namespace).toBe('dispatch');
    expect(first.reference.contextEntityId).toBe('order:dispatch:DSP-1042');
    const eventsAfterFirst = world.eventCount();

    const replay = await world.ingestSnapshot(await snapshot('DSP-1042'), []);
    expect(replay.processed).toBe(0);
    expect(replay.changed).toBe(false);
    expect(replay.eventId).toBe(first.eventId);
    expect(world.eventCount()).toBe(eventsAfterFirst);

    const context = world.uiState('DSP-1042').context;
    expect(context?.order.name).toBe('Adeyemi Wedding Ceremony');
    expect(context?.neighbours.some((neighbour) => neighbour.via === 'requires')).toBe(true);
  });

  it('persists the namespace as JSON and reads it back after a restart', async () => {
    const first = await world.ingestSnapshot(await snapshot('DSP-1042'), []);
    const events = world.eventCount();
    expect(fs.existsSync(world.filePath)).toBe(true);

    const reopened = new WorldModelService({
      dataDir,
      clock: () => new Date(FROZEN_SCENARIO_TIME_ISO)
    });
    expect(reopened.eventCount()).toBe(events);
    expect(reopened.uiState('DSP-1042').headEventId).toBe(first.eventId);
    expect(reopened.uiState('DSP-1042').context?.order.name).toBe('Adeyemi Wedding Ceremony');
  });

  it('keeps shared records and every SKU stable when orders are revisited', async () => {
    const snapshots = await Promise.all(
      ['DSP-1042', 'DSP-1043', 'DSP-1044', 'DSP-1045'].map(snapshot)
    );
    for (const current of snapshots) await world.ingestSnapshot(current);
    const count = world.eventCount();
    for (const current of snapshots) {
      const replay = await world.ingestSnapshot(current);
      expect(replay.changed).toBe(false);
      expect(replay.processed).toBe(0);
      const backupRecords = replay.reference.resolvedSuppliers.flatMap((supplier) =>
        supplier.sourceRecords.filter((record) => record.sourceType === 'backup_listings')
      );
      if (current.sources.backupListing) {
        expect(backupRecords).toEqual([
          expect.objectContaining({
            recordId: current.sources.backupListing.recordId,
            revisionId: current.sources.backupListing.revisionId
          })
        ]);
      } else expect(backupRecords).toEqual([]);
      expect(replay.context?.neighbours.some((neighbour) => neighbour.via === 'stocks')).toBe(true);
    }
    expect(world.eventCount()).toBe(count);
  });

  it('serializes duplicate ingests without creating duplicate events', async () => {
    const current = await snapshot('DSP-1043');
    const [first, second] = await Promise.all([
      world.ingestSnapshot(current),
      world.ingestSnapshot(current)
    ]);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.eventId).toBe(first.eventId);
  });

  it('uses source audit time for numeric revision suffixes and ignores the fetch clock', async () => {
    await sources.writeWarehouse({
      ...DEMO_WAREHOUSE,
      revisionId: 'REV-INV-91234567',
      damaged: 25
    });
    const current = await snapshot('DSP-1042');
    const first = await world.ingestSnapshot(current);
    const replay = await world.ingestSnapshot({
      ...current,
      sources: {
        ...current.sources,
        inventory: { ...current.sources.inventory, timestampIso: '2026-11-01T12:00:00Z' }
      }
    });
    expect(first.changed).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.eventId).toBe(first.eventId);
  });

  it('mirrors released SQL holds without showing an active reservation after reload', async () => {
    const receipt = (await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator))
      .receipt;
    recovery.approvePlan({
      receiptId: receipt.receiptId,
      expectedVersion: receipt.version,
      actor: SEEDED_USERS.manager,
      idempotencyKey: 'world-hold'
    });
    const current = await snapshot('DSP-1042');
    await world.ingestSnapshot(current, recovery.listReservations());
    expect(
      world
        .contextForOrder('DSP-1042')
        ?.neighbours.some((neighbour) => neighbour.via === 'reserves')
    ).toBe(true);
    recovery.invalidatePlanOnSourceChange(receipt.receiptId, 'Stock revised');
    await world.ingestSnapshot(current, recovery.listReservations());
    const reopened = new WorldModelService({ dataDir });
    expect(
      reopened
        .contextForOrder('DSP-1042')
        ?.neighbours.some((neighbour) => neighbour.via === 'reserves')
    ).toBe(false);
    const again = await reopened.ingestSnapshot(current, recovery.listReservations());
    expect(again.changed).toBe(false);
  });

  it.each(['pending', 'rejected', 'approved'] as const)(
    'uses a %s identity snapshot for deterministic supplier confirmation',
    async (decision) => {
      let receipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
        .receipt;
      const match = world.matches().find((candidate) => candidate.status === 'pending')!;
      if (decision !== 'pending') {
        await world.resolveMatch(
          match.proposalId,
          decision === 'approved' ? 'approve' : 'reject',
          SEEDED_USERS.manager.name
        );
        receipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator)).receipt;
      }
      const approved = recovery.approvePlan({
        receiptId: receipt.receiptId,
        expectedVersion: receipt.version,
        actor: SEEDED_USERS.manager,
        idempotencyKey: 'identity-confirm'
      });
      const confirm = () =>
        recovery.recordSupplierConfirmation({
          receiptId: receipt.receiptId,
          expectedVersion: approved.receipt.version,
          actor: SEEDED_USERS.operator,
          idempotencyKey: 'confirm-alias',
          confirmation: {
            supplierName: 'LEKKI PARTY SUPPLIES',
            sku: receipt.calculations.sku,
            confirmedQuantity: receipt.calculations.shortfall,
            confirmedArrivalIso: '2026-10-24T07:00:00+01:00',
            confirmationReference: 'SIM-ALIAS',
            evidenceExcerpt: 'Simulated supplier evidence: 60 chairs arrive Saturday at 07:00 WAT.'
          }
        });
      if (decision === 'approved') expect(confirm().receipt.status).toBe('confirmed');
      else {
        expect(confirm).toThrow(
          expect.objectContaining({ code: 'CONFIRMATION_SUPPLIER_MISMATCH' })
        );
        expect(recovery.getConfirmation(receipt.receiptId)).toBeUndefined();
      }
    }
  );

  it('records a bounded World Model context query under the same Scout contract', async () => {
    const receipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
      .receipt;
    const query = receipt.worldModel?.contextQuery;
    expect(query?.contractId).toBe(receipt.scout?.contractId);
    expect(query?.subjectEntityId).toBe('order:dispatch:DSP-1043');
    expect(query?.relations).toEqual(
      expect.arrayContaining(['requires', 'stocks', 'supplies', 'offers'])
    );
    expect(query!.entityIds.length).toBeLessThanOrEqual(query!.limit);
    expect(query!.entityIds.length).toBeGreaterThan(1);
  });

  it('refuses a forged Scout contract before ingesting or answering context', async () => {
    const scout = createDispatchScout({ dataDir, modelId: 'mock-world-context' });
    const decision = await scout.decide({
      prompt: 'Investigate order DSP-1043',
      user: { id: SEEDED_USERS.operator.userId, role: 'operator' },
      surface: 'desk'
    });
    const trace = await executeLookupContract({
      scout,
      contract: decision.executionContract!,
      orderId: 'DSP-1043',
      timestampIso: FROZEN_SCENARIO_TIME_ISO,
      sources
    });
    trace.contract = { ...trace.contract, signature: 'tampered' };
    await expect(
      answerWorldContext({
        world,
        scout,
        trace,
        snapshot: await snapshot('DSP-1043'),
        reservations: []
      })
    ).rejects.toMatchObject({ code: 'CONTRACT_REFUSED' });
    expect(world.eventCount()).toBe(0);
  });

  it('does not retroactively authorize a supplier alias on an older receipt', async () => {
    const receipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
      .receipt;
    const pending = world.matches().find((match) => match.status === 'pending')!;
    await world.resolveMatch(pending.proposalId, 'approve', SEEDED_USERS.manager.name);
    const approved = recovery.approvePlan({
      receiptId: receipt.receiptId,
      expectedVersion: receipt.version,
      actor: SEEDED_USERS.manager,
      idempotencyKey: 'old-identity'
    });
    expect(() =>
      recovery.recordSupplierConfirmation({
        receiptId: receipt.receiptId,
        expectedVersion: approved.receipt.version,
        actor: SEEDED_USERS.operator,
        idempotencyKey: 'old-confirm',
        confirmation: {
          supplierName: 'LEKKI PARTY SUPPLIES',
          sku: receipt.calculations.sku,
          confirmedQuantity: 60,
          confirmedArrivalIso: '2026-10-24T07:00:00+01:00',
          confirmationReference: 'SIM-OLD',
          evidenceExcerpt: 'Simulated supplier confirmation of 60 chairs arriving at07:00WAT.'
        }
      })
    ).toThrow(expect.objectContaining({ code: 'CONFIRMATION_SUPPLIER_MISMATCH' }));
    expect(recovery.getConfirmation(receipt.receiptId)).toBeUndefined();
  });

  it('queues the 0.8333 pair for review, keeps it out of decisions, then merges on approval', async () => {
    const pendingReceipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
      .receipt;
    expect(pendingReceipt.worldModel?.contextEntityId).toBe('order:dispatch:DSP-1043');
    expect(pendingReceipt.worldModel?.runId).toMatch(/^run_/);
    expect(pendingReceipt.agentFindings.uncertainties.join('\n')).not.toContain('one identity');
    expect(pendingReceipt.status).toBe('awaiting_approval');

    const pending = world.matches().filter((match) => match.status === 'pending');
    const review = pending.find(
      (match) =>
        match.leftName === 'Lekki Party Supplies Ltd' ||
        match.rightName === 'Lekki Party Supplies Ltd'
    );
    expect(review?.similarity).toBeCloseTo(0.8333, 4);

    const before = world.uiState('DSP-1043').context?.suppliers ?? [];
    expect(before).toHaveLength(2);
    expect(before.every((supplier) => supplier.status === 'pending_review')).toBe(true);
    expect(
      before.some((supplier) =>
        supplier.sourceRecords.some((record) => record.sourceType === 'backup_listings')
      )
    ).toBe(true);

    const approved = await world.resolveMatch(
      review!.proposalId,
      'approve',
      SEEDED_USERS.manager.name
    );
    expect(approved.status).toBe('approved');
    expect(approved.resolvedBy).toBe(SEEDED_USERS.manager.name);

    const after = world.uiState('DSP-1043').context?.suppliers ?? [];
    expect(after).toHaveLength(1);
    expect(after[0]?.status).toBe('merged');
    expect(after[0]?.names).toEqual(
      expect.arrayContaining([
        'LEKKI PARTY SUPPLIES',
        'Lekki Party Supplies',
        'Lekki Party Supplies Ltd'
      ])
    );
    expect(after[0]?.sourceRecords.map((record) => record.sourceType).sort()).toEqual([
      'backup_listings',
      'inbound_shipments',
      'supplier_updates'
    ]);

    const mergedReceipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
      .receipt;
    expect(mergedReceipt.agentFindings.uncertainties.join('\n')).toContain(
      'one identity (Lekki Party Supplies'
    );
    expect(mergedReceipt.status).toBe('awaiting_approval');
    expect(mergedReceipt.worldModel?.eventId).toBe(world.uiState('DSP-1043').headEventId);
  });

  it('keeps a rejected pair as two identities and persists the rejection', async () => {
    const receipt = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator))
      .receipt;
    const pending = world.matches().find((match) => match.status === 'pending');
    expect(pending).toBeDefined();

    const rejected = await world.resolveMatch(
      pending!.proposalId,
      'reject',
      SEEDED_USERS.manager.name
    );
    expect(rejected.status).toBe('rejected');

    const reopened = new WorldModelService({
      dataDir,
      clock: () => new Date(FROZEN_SCENARIO_TIME_ISO)
    });
    const persisted = reopened.matches().find((match) => match.proposalId === pending!.proposalId);
    expect(persisted).toMatchObject({ status: 'rejected', resolvedBy: SEEDED_USERS.manager.name });
    expect(reopened.uiState('DSP-1043').context?.suppliers).toHaveLength(2);
    await expect(
      reopened.resolveMatch(pending!.proposalId, 'approve', SEEDED_USERS.manager.name)
    ).rejects.toMatchObject({ code: 'MATCH_NOT_FOUND' });

    const again = (await investigation.investigateOrder('DSP-1043', SEEDED_USERS.operator)).receipt;
    expect(again.agentFindings.uncertainties.join('\n')).not.toContain('one identity');
    expect(again.status).toBe(receipt.status);
    expect(again.candidateRemedy?.listingId).toBe(receipt.candidateRemedy?.listingId);
  });

  it('reset deletes the namespace and a rebuild starts from the source revisions again', async () => {
    await world.ingestSnapshot(await snapshot('DSP-1042'), []);
    expect(world.eventCount()).toBeGreaterThan(0);
    expect(fs.existsSync(world.filePath)).toBe(true);

    await world.reset();
    expect(world.eventCount()).toBe(0);
    expect(fs.existsSync(world.filePath)).toBe(false);
    expect(world.uiState('DSP-1042').context).toBeNull();

    const rebuilt = await world.ingestSnapshot(await snapshot('DSP-1042'), []);
    expect(rebuilt.changed).toBe(true);
    expect(world.eventCount()).toBeGreaterThan(0);
    expect(world.uiState('DSP-1042').context?.order.name).toBe('Adeyemi Wedding Ceremony');
  });
});
