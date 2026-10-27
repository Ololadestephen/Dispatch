import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { InvestigationService } from '../../src/application/investigationService';
import { createDispatchScout } from '../../src/integrations/meterless/dispatchScout';
import { LocalFileStore, SourceGateway } from '../../src/integrations/sources';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { RecoveryService } from '../../src/application/recoveryService';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import { ModelOutageError } from '../../src/domain/errors';
import { runTmp } from '../support/runRoot';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT,
  SEEDED_USERS
} from '../../src/demo/seedData';

const scoutDir = runTmp('scout_key');

describe('T10-T13: Full Source-to-Receipt Investigation & Outage Handling', () => {
  const testDataDir = runTmp('investigation_data');
  let sources: SourceGateway;
  let clock: FrozenClock;
  let recoveryService: RecoveryService;

  beforeEach(async () => {
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }

    sources = new SourceGateway(new LocalFileStore(testDataDir), new LocalFileStore(testDataDir));
    await sources.seed({
      orders: [DEMO_ORDER],
      warehouses: [DEMO_WAREHOUSE],
      supplierMessages: [DEMO_SUPPLIER_MESSAGE],
      backupListings: [DEMO_BACKUP_LISTING],
      inboundShipments: [DEMO_INBOUND_SHIPMENT]
    });

    clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);
    recoveryService = new RecoveryService(clock);
  });

  afterEach(() => {
    recoveryService.database.db.close();
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it.each(['mock', 'outage'])(
    'does not commit a %s receipt if its required evidence export fails',
    async (mode) => {
      const blocked = path.join(testDataDir, 'evidence-is-a-file');
      fs.writeFileSync(blocked, 'occupied');
      const agent = NvidiaExtractionAgent.createWithMock();
      if (mode === 'outage')
        vi.spyOn(agent, 'extractSupplierFindings').mockRejectedValue(
          new ModelOutageError('Offline')
        );
      const service = new InvestigationService(
        sources,
        agent,
        recoveryService,
        clock,
        createDispatchScout({ dataDir: scoutDir, modelId: 'test' }),
        blocked
      );
      await expect(service.investigateOrder('DSP-1042', SEEDED_USERS.operator)).rejects.toThrow();
      expect(recoveryService.getReceipt('RCP-DSP-1042-01')).toBeUndefined();
      expect(recoveryService.getAuditEvents()).toEqual([]);
    }
  );

  it('does not disguise unexpected extraction bugs as model outages', async () => {
    const agent = NvidiaExtractionAgent.createWithMock();
    vi.spyOn(agent, 'extractSupplierFindings').mockRejectedValue(
      new TypeError('Unexpected extraction bug')
    );
    const service = new InvestigationService(
      sources,
      agent,
      recoveryService,
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'test' })
    );
    await expect(service.investigateOrder('DSP-1042', SEEDED_USERS.operator)).rejects.toThrow(
      'Unexpected extraction bug'
    );
    expect(recoveryService.getReceipt('RCP-DSP-1042-01')).toBeUndefined();
  });

  it('produces an auditable Decision Receipt using explicit mock-injected agent', async () => {
    const mockAgent = NvidiaExtractionAgent.createWithMock();
    const investigationService = new InvestigationService(
      sources,
      mockAgent,
      recoveryService,
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'test' })
    );

    const result = await investigationService.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    const { receipt } = result;

    expect(receipt.executionMode).toBe('mock');
    expect(receipt.status).toBe('awaiting_approval');
    expect(receipt.calculations.requiredQuantity).toBe(120);
    expect(receipt.calculations.physicallyPresent).toBe(80);
    expect(receipt.calculations.damaged).toBe(20);
    expect(receipt.calculations.usableAvailable).toBe(60);
    expect(receipt.calculations.eligibleIncoming).toBe(0);
    expect(receipt.calculations.shortfall).toBe(60);
    expect(receipt.calculations.hasShortage).toBe(true);

    // Arrival ISO parsed deterministically from extracted text ("Monday 26 Oct, 9am")
    expect(receipt.timing.supplierExpectedArrivalIso).toBe('2026-10-26T09:00:00+01:00');
    expect(receipt.financial.extraCostKobo).toBe(9_000_000);
    expect(receipt.financial.requiresManagerApproval).toBe(true);

    expect(receipt.sourceRevisions.length).toBe(5);
    expect(receipt.investigationSteps?.length).toBe(6);
    expect(receipt.agentFindings.ignoredInstructions[0]).toContain(
      'mark order DSP-1042 as delivered'
    );
    expect(receipt.agentFindings.ignoredInstructionSpans?.[0]?.startIndex).toBeGreaterThan(0);
    // Lookups ran under one signed Scout contract; the mock model and the Scout guard
    // independently found the same "mark as delivered" span.
    expect(receipt.scout?.intent).toBe('order.investigate');
    expect(
      receipt.investigationSteps?.every((st) => st.contractId === receipt.scout?.contractId)
    ).toBe(true);
    expect(receipt.scout?.supplierScreen.level).toBe('block');
    expect(receipt.agentFindings.ignoredInstructionSpans).toHaveLength(1);
    expect(receipt.agentFindings.ignoredInstructionSpans?.[0]?.detectedBy).toEqual([
      'model',
      'scout'
    ]);

    const approvalResult = recoveryService.approvePlan({
      receiptId: receipt.receiptId,
      expectedVersion: receipt.version,
      actor: SEEDED_USERS.manager,
      idempotencyKey: 'idemp-investigation-test'
    });

    expect(approvalResult.receipt.status).toBe('awaiting_confirmation');
    expect(approvalResult.tasks.length).toBe(2);
    expect(approvalResult.supplierDraft.requestedQuantity).toBe(60);
    expect(approvalResult.supplierDraft.isSent).toBe(false);

    const finalReceipt = recoveryService.recordSupplierConfirmation({
      receiptId: receipt.receiptId,
      expectedVersion: approvalResult.receipt.version,
      actor: SEEDED_USERS.operator,
      idempotencyKey: 'confirm-key-0001',
      confirmation: {
        supplierName: 'Lekki Party Supplies Ltd',
        sku: 'CHR-GOLD-CHIAVARI',
        confirmedQuantity: 60,
        confirmedArrivalIso: '2026-10-24T07:00:00+01:00',
        confirmationReference: 'CONF-FINAL-4401',
        evidenceExcerpt: 'Simulated: Lekki confirms 60 chairs at 07:00 WAT Saturday.'
      }
    });

    expect(finalReceipt.receipt.status).toBe('confirmed');
  });

  it('produces an explicit incomplete receipt when live model call fails (no silent fallback)', async () => {
    const failingLiveAgent = new NvidiaExtractionAgent({
      apiKey: 'nvapi-unreachable',
      baseUrl: 'http://127.0.0.1:1/unreachable'
    });
    const investigationService = new InvestigationService(
      sources,
      failingLiveAgent,
      recoveryService,
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'test' })
    );

    const result = await investigationService.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    const { receipt } = result;

    expect(receipt.status).toBe('incomplete');
    expect(receipt.executionMode).toBe('incomplete');
    expect(receipt.timing.supplierExpectedArrivalIso).toBe('UNVERIFIED');
    expect(receipt.agentFindings.extractedQuotes).toEqual([]);
    // With no model output, Scout's deterministic screen still reports the embedded instruction.
    expect(receipt.agentFindings.ignoredInstructionSpans?.[0]?.detectedBy).toEqual(['scout']);
    expect(receipt.agentFindings.ignoredInstructions[0]).toContain(
      'mark order DSP-1042 as delivered'
    );
    expect(receipt.agentFindings.uncertainties[0]).toContain('Model/extraction failure');

    // Incomplete receipt cannot be approved
    expect(() =>
      recoveryService.approvePlan({
        receiptId: receipt.receiptId,
        expectedVersion: receipt.version,
        actor: SEEDED_USERS.manager,
        idempotencyKey: 'idemp-cannot-approve-incomplete'
      })
    ).toThrow(/Cannot transition recovery plan from state 'incomplete' to 'approved'/);
  });

  it.each([
    {
      scenario: 'a backup arriving at 10:00, after the 08:00 cutoff',
      changes: { statedDeliveryArrivalIso: '2026-10-24T10:00:00+01:00' }
    },
    {
      scenario: 'a backup offering 20 of the 60 chairs needed',
      changes: { availableQuantity: 20 }
    },
    {
      scenario: 'an unavailable backup with zero chairs',
      changes: { availableQuantity: 0 }
    }
  ])('keeps $scenario out of the approval queue', async ({ changes }) => {
    await sources.seed({
      orders: [DEMO_ORDER],
      warehouses: [DEMO_WAREHOUSE],
      supplierMessages: [DEMO_SUPPLIER_MESSAGE],
      backupListings: [{ ...DEMO_BACKUP_LISTING, ...changes }],
      inboundShipments: [DEMO_INBOUND_SHIPMENT]
    });
    const service = new InvestigationService(
      sources,
      NvidiaExtractionAgent.createWithMock(),
      recoveryService,
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'test' })
    );

    const { receipt } = await service.investigateOrder('DSP-1042', SEEDED_USERS.operator);

    expect(receipt.status).toBe('proposed');
    expect(receipt.calculations.shortfall).toBe(60);
    expect(receipt.calculations.eligibleIncoming).toBe(0);
    expect(receipt.agentFindings.uncertainties).toContainEqual(expect.stringMatching(/Backup /));
    expect(() =>
      recoveryService.approvePlan({
        receiptId: receipt.receiptId,
        expectedVersion: receipt.version,
        actor: SEEDED_USERS.manager,
        idempotencyKey: 'infeasible-investigation-approval'
      })
    ).toThrow();
    expect(recoveryService.getTasks(receipt.receiptId)).toEqual([]);
    expect(recoveryService.getSupplierDraft(receipt.receiptId)).toBeUndefined();
  });
});
