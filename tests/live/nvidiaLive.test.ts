/**
 * Live model tests. Run with `npm run test:live` only; each run makes 2 NVIDIA calls.
 * They FAIL (never skip, never fall back) when the key, network or model is unavailable,
 * and save their receipt to .local/evidence/ with the execution mode in the filename.
 */
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { InvestigationService } from '../../src/application/investigationService';
import { createDispatchScout } from '../../src/integrations/meterless/dispatchScout';

const scoutDir = path.join(process.cwd(), 'tests/.tmp/scout_key');
import { RecoveryService } from '../../src/application/recoveryService';
import { LocalFileStore, SourceGateway } from '../../src/integrations/sources';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT,
  SEEDED_USERS
} from '../../src/demo/seedData';

const dataDir = path.join(process.cwd(), 'tests/.tmp/live_sources');
const evidenceDir = path.join(process.cwd(), '.local/evidence');

describe('Live NVIDIA extraction (2 calls)', () => {
  const sources = new SourceGateway(new LocalFileStore(dataDir), new LocalFileStore(dataDir));

  beforeAll(async () => {
    await sources.seed({
      orders: [DEMO_ORDER],
      warehouses: [DEMO_WAREHOUSE],
      supplierMessages: [DEMO_SUPPLIER_MESSAGE],
      backupListings: [DEMO_BACKUP_LISTING],
      inboundShipments: [DEMO_INBOUND_SHIPMENT]
    });
  });
  afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  it('extracts quantity, arrival and the ignored instruction as exact source spans', async () => {
    const agent = new NvidiaExtractionAgent();
    expect(agent.hasLiveNvidiaCredentials()).toBe(true);

    const result = await agent.extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText);

    expect(result.metrics.executionMode).toBe('live');
    expect(result.extraction.delayedQuantity).toBe(60);
    for (const span of [...result.resolvedQuotes, ...result.resolvedIgnoredInstructions]) {
      expect(DEMO_SUPPLIER_MESSAGE.rawMessageText.slice(span.startIndex, span.endIndex)).toBe(
        span.text
      );
    }
    expect(result.resolvedIgnoredInstructions.map((s) => s.text).join(' ')).toContain(
      'mark order DSP-1042 as delivered'
    );
  });

  it('produces a live receipt: 60 short, Monday arrival excluded, instruction ignored', async () => {
    const clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);
    const service = new InvestigationService(
      sources,
      new NvidiaExtractionAgent(),
      new RecoveryService(clock),
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'meta/llama-3.2-11b-vision-instruct' }),
      evidenceDir
    );

    const { receipt, modelMetrics, evidenceSavedPath } = await service.investigateOrder(
      'DSP-1042',
      SEEDED_USERS.operator
    );

    expect(receipt.agentFindings.uncertainties.join('\n')).not.toContain(
      'Model/extraction failure'
    );
    expect(receipt.executionMode).toBe('live');
    expect(modelMetrics.isLiveCall).toBe(true);
    expect(receipt.status).toBe('awaiting_approval');
    expect(receipt.timing.supplierExpectedArrivalIso).toBe('2026-10-26T09:00:00+01:00');
    expect(receipt.calculations.eligibleIncoming).toBe(0);
    expect(receipt.calculations.shortfall).toBe(60);
    expect(receipt.agentFindings.ignoredInstructions.join(' ')).toContain(
      'mark order DSP-1042 as delivered'
    );
    expect(evidenceSavedPath).toMatch(/_live_/);
  });
});
