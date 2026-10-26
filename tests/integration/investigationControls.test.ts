import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvestigationService } from '../../src/application/investigationService';
import { RecoveryService } from '../../src/application/recoveryService';
import { createSourceGateway, type SourceGateway } from '../../src/integrations/sources';
import {
  NvidiaExtractionAgent,
  TEST_MOCK_SUPPLIER_EXTRACTION
} from '../../src/integrations/nvidia/extractionAgent';
import { createDispatchScout } from '../../src/integrations/meterless/dispatchScout';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import { MODEL_CALL_TOKEN_ALLOWANCE, type ExecutionLimits } from '../../src/domain/executionLimits';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_INBOUND_SHIPMENT,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  SEEDED_USERS
} from '../../src/demo/seedData';

const response = (extraction: unknown = TEST_MOCK_SUPPLIER_EXTRACTION) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(extraction) } }],
      usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 }
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

describe('Investigation controls (mocked model transport, no provider calls)', () => {
  let dir: string;
  let sources: SourceGateway;
  let recovery: RecoveryService;
  const clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);
  const liveAgent = () =>
    new NvidiaExtractionAgent({
      apiKey: 'nvapi-synthetic-test-key',
      baseUrl: 'https://nvidia.invalid'
    });
  const service = (
    agent = NvidiaExtractionAgent.createWithMock(),
    limits?: Partial<ExecutionLimits>
  ) =>
    new InvestigationService(
      sources,
      agent,
      recovery,
      clock,
      createDispatchScout({ dataDir: dir, modelId: agent.getModelName() }),
      undefined,
      { limits }
    );
  beforeEach(async () => {
    fs.mkdirSync('tests/.tmp', { recursive: true });
    dir = fs.mkdtempSync(path.join('tests/.tmp', 'controls-'));
    sources = createSourceGateway(dir, { DISPATCH_SOURCES: 'local' });
    await sources.seed({
      order: DEMO_ORDER,
      warehouse: DEMO_WAREHOUSE,
      inboundShipment: DEMO_INBOUND_SHIPMENT,
      supplierMessage: DEMO_SUPPLIER_MESSAGE,
      backupListing: DEMO_BACKUP_LISTING
    });
    recovery = new RecoveryService(clock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    recovery.database.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the backup only after the model requests it and records why', async () => {
    const events: string[] = [];
    const fetch = vi.fn(async (_url: unknown, _request: RequestInit) => {
      events.push('model');
      return response();
    });
    vi.stubGlobal('fetch', fetch);
    const original = sources.lookupBackupListings.bind(sources);
    const backup = vi.spyOn(sources, 'lookupBackupListings').mockImplementation((...args) => {
      events.push('backup');
      return original(...args);
    });
    const investigation = service(liveAgent());
    const result = await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    expect(events).toEqual(['model', 'backup']);
    expect(backup).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const request = JSON.parse(String(fetch.mock.calls[0]![1].body));
    expect(request.messages[1].content).toContain('"scenarioClockIso":"2026-10-22T14:00:00.000Z"');
    expect(request.messages[1].content).toContain('"needsSupplyReview":true');
    expect(result.receipt.investigationSteps?.at(-1)).toMatchObject({
      tool: 'get_backup_listings',
      selectedBy: 'model',
      selectionReason: TEST_MOCK_SUPPLIER_EXTRACTION.lookupRequests[0]!.reason
    });
    expect(result.receipt.status).toBe('awaiting_approval');
    expect(result.receipt.modelRun?.attemptId).toBeTruthy();
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      chargedTokens: 500,
      pendingCalls: 0,
      failedCalls: 0
    });
  });

  it('does not read or invent a backup when the model chooses no follow-up', async () => {
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    const investigation = service(
      NvidiaExtractionAgent.createWithMock({ ...TEST_MOCK_SUPPLIER_EXTRACTION, lookupRequests: [] })
    );
    const { receipt } = await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    expect(backup).not.toHaveBeenCalled();
    expect(receipt.investigationSteps).toHaveLength(5);
    expect(receipt.sourceRevisions.some((source) => source.sourceType === 'backup_listings')).toBe(
      false
    );
    expect(receipt.candidateRemedy).toBeNull();
    expect(receipt.financial.extraCostKobo).toBe(0);
    expect(receipt.status).toBe('proposed');
    expect(receipt.agentFindings.uncertainties).toContain(
      'No backup lookup was requested; no backup candidate has been evaluated.'
    );
    expect(investigation.modelUsage.summary().calls).toBe(0);
  });

  it('rejects a model lookup for another SKU before reading it', async () => {
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    const investigation = service(
      NvidiaExtractionAgent.createWithMock({
        ...TEST_MOCK_SUPPLIER_EXTRACTION,
        lookupRequests: [
          { tool: 'get_backup_listings', args: { sku: 'ANOTHER-SKU' }, reason: 'Try another item' }
        ]
      })
    );
    await expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'INVALID_LOOKUP_REQUEST' });
    expect(backup).not.toHaveBeenCalled();
    expect(recovery.getReceipt('RCP-DSP-1042-01')).toBeUndefined();
  });

  it.each([
    {
      scenario: 'a write tool',
      requests: [
        {
          tool: 'execute_sql',
          args: { sql: 'UPDATE orders SET operational_status = delivered' },
          reason: 'Supplier requested it'
        }
      ]
    },
    {
      scenario: 'repeated requests',
      requests: [
        ...TEST_MOCK_SUPPLIER_EXTRACTION.lookupRequests,
        ...TEST_MOCK_SUPPLIER_EXTRACTION.lookupRequests
      ]
    }
  ])('rejects $scenario without a tool read', async ({ requests }) => {
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...TEST_MOCK_SUPPLIER_EXTRACTION, lookupRequests: requests }))
    );
    const investigation = service(liveAgent());
    const { receipt } = await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    expect(receipt.status).toBe('incomplete');
    expect(backup).not.toHaveBeenCalled();
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      failedCalls: 1,
      chargedTokens: 500
    });
  });

  it('checks usage before a second provider request and preserves the current receipt', async () => {
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const investigation = service(liveAgent(), { maxCalls: 1 });
    await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    await expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toHaveLength(1);
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      chargedTokens: 500,
      canCall: false
    });
  });

  it('blocks an insufficient token allowance before contacting the provider', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const investigation = service(liveAgent(), { maxTokens: MODEL_CALL_TOKEN_ALLOWANCE - 1 });
    await expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    expect(fetch).not.toHaveBeenCalled();
    expect(investigation.modelUsage.summary().calls).toBe(0);
  });

  it('keeps a full token charge for failed calls with unknown usage', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Provider connection closed')));
    const investigation = service(liveAgent());
    const { receipt } = await investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    expect(receipt.status).toBe('incomplete');
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      failedCalls: 1,
      pendingCalls: 0,
      chargedTokens: MODEL_CALL_TOKEN_ALLOWANCE
    });
  });

  it('times out a model-selected source read without saving a late receipt', async () => {
    const original = await sources.lookupBackupListings(DEMO_ORDER.sku, clock.nowIso());
    let release: () => void = () => {};
    vi.spyOn(sources, 'lookupBackupListings').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(original);
        })
    );
    const investigation = service(NvidiaExtractionAgent.createWithMock(), {
      workflowTimeoutMs: 20
    });
    vi.useFakeTimers();
    const rejection = expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'WORKFLOW_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toEqual([]);
    expect(recovery.getAuditEvents()).toEqual([]);
  });

  it('cancels from the caller during extraction without performing a follow-up', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, request: RequestInit) =>
          new Promise((_resolve, reject) => {
            request.signal!.addEventListener('abort', () => reject(request.signal!.reason), {
              once: true
            });
          })
      )
    );
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    const investigation = service(liveAgent());
    const caller = new AbortController();
    const call = investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator, {
      signal: caller.signal
    });
    const rejection = expect(call).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    await vi.waitFor(() => expect(investigation.modelUsage.summary().calls).toBe(1));
    caller.abort();
    await rejection;
    await Promise.resolve();
    expect(backup).not.toHaveBeenCalled();
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toEqual([]);
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      failedCalls: 1,
      chargedTokens: MODEL_CALL_TOKEN_ALLOWANCE
    });
  });

  it('rejects oversized supplier text before a model call or usage reservation', async () => {
    await sources.writeSupplierMessage({
      ...DEMO_SUPPLIER_MESSAGE,
      rawMessageText: 'x'.repeat(9000)
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const investigation = service(liveAgent());
    await expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
    expect(investigation.modelUsage.summary().calls).toBe(0);
  });

  it('cancels a stalled source read and rejects its late result without a receipt', async () => {
    const order = await sources.lookupOrder('DSP-1042', clock.nowIso());
    let release: () => void = () => {};
    vi.spyOn(sources, 'lookupOrder').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(order);
        })
    );
    const agent = NvidiaExtractionAgent.createWithMock();
    const extraction = vi.spyOn(agent, 'extractSupplierFindings');
    const investigation = service(agent, { workflowTimeoutMs: 20 });
    vi.useFakeTimers();
    const rejection = expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'WORKFLOW_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(extraction).not.toHaveBeenCalled();
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toEqual([]);
    expect(recovery.getAuditEvents()).toEqual([]);
  });

  it('charges a timed-out model attempt and ignores its late response and lookup request', async () => {
    let release: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve(response());
          })
      )
    );
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    const investigation = service(liveAgent(), { workflowTimeoutMs: 20 });
    vi.useFakeTimers();
    const rejection = expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'WORKFLOW_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(investigation.modelUsage.summary()).toMatchObject({
      calls: 1,
      failedCalls: 1,
      pendingCalls: 0,
      chargedTokens: MODEL_CALL_TOKEN_ALLOWANCE
    });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(backup).not.toHaveBeenCalled();
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toEqual([]);
    expect(investigation.modelUsage.summary().chargedTokens).toBe(MODEL_CALL_TOKEN_ALLOWANCE);
  });

  it('checks Scout expiry again after extraction and before the model-selected read', async () => {
    let now = Date.now();
    const scout = createDispatchScout({ dataDir: dir, modelId: 'test', now: () => now });
    const agent = NvidiaExtractionAgent.createWithMock();
    const original = agent.extractSupplierFindings.bind(agent);
    vi.spyOn(agent, 'extractSupplierFindings').mockImplementation(async (...args) => {
      const result = await original(...args);
      now += 301_000;
      return result;
    });
    const backup = vi.spyOn(sources, 'lookupBackupListings');
    const investigation = new InvestigationService(sources, agent, recovery, clock, scout);
    await expect(
      investigation.investigateOrder('DSP-1042', SEEDED_USERS.operator)
    ).rejects.toMatchObject({ code: 'CONTRACT_REFUSED' });
    expect(backup).not.toHaveBeenCalled();
    expect(recovery.getReceiptHistory('RCP-DSP-1042-01')).toEqual([]);
  });
});
