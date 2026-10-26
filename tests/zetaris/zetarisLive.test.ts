/**
 * Real Zetaris integration. Run with `npm run test:zetaris` after `npm run zetaris:setup`,
 * with the local Zetaris platform and the dispatch-sources containers running.
 * Uses the explicit mock model, so it makes no NVIDIA calls. Fails (never skips) if Zetaris is down.
 */
import path from 'node:path';
import fs from 'node:fs';
import { describe, it, expect, beforeAll } from 'vitest';
import { createSourceGateway, SourceGateway } from '../../src/integrations/sources';
import { InvestigationService } from '../../src/application/investigationService';
import { RecoveryService } from '../../src/application/recoveryService';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { createDispatchScout } from '../../src/integrations/meterless/dispatchScout';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT,
  SEEDED_USERS
} from '../../src/demo/seedData';

process.loadEnvFile(path.join(process.cwd(), '.env.local'));
const scoutDir = path.join(process.cwd(), 'tests/.tmp/zetaris_scout');
const ts = FROZEN_SCENARIO_TIME_ISO;

describe('Dispatch over a real Zetaris platform', () => {
  let gateway: SourceGateway;

  beforeAll(async () => {
    gateway = createSourceGateway(path.join(process.cwd(), 'tests/.tmp/zetaris_unused'), {
      ...process.env,
      DISPATCH_SOURCES: 'zetaris'
    });
    await gateway.seed({
      order: DEMO_ORDER,
      warehouse: DEMO_WAREHOUSE,
      supplierMessage: DEMO_SUPPLIER_MESSAGE,
      backupListing: DEMO_BACKUP_LISTING,
      inboundShipment: DEMO_INBOUND_SHIPMENT
    });
  });

  it('reads all five records through Zetaris across PostgreSQL and file tables', async () => {
    const snapshot = await gateway.fetchEvidenceSnapshot('DSP-1042', ts);
    expect(snapshot.providerMode).toBe('zetaris');
    expect(snapshot.sources.orders.sourceId).toBe('zetaris:DISPATCH_ORDERS_PG.orders');
    expect(snapshot.sources.inventory.sourceId).toBe('zetaris:DISPATCH_FILES.warehouse_inventory');
    expect(snapshot.topology.backingSystems).toEqual(
      expect.arrayContaining([
        'zetaris_jdbc_postgresql',
        'zetaris_filestore_csv',
        'zetaris_filestore_json'
      ])
    );
    expect(snapshot.sources.supplierUpdates.data.rawMessageText).toBe(
      DEMO_SUPPLIER_MESSAGE.rawMessageText
    );
    expect(snapshot.sources.backupListing?.data.costKobo).toBe(9_000_000);
  });

  it('runs a Scout-gated investigation whose lookups are all Zetaris queries', async () => {
    const clock = new FrozenClock(ts);
    const service = new InvestigationService(
      gateway,
      NvidiaExtractionAgent.createWithMock(),
      new RecoveryService(clock),
      clock,
      createDispatchScout({ dataDir: scoutDir, modelId: 'mock' })
    );
    const { receipt } = await service.investigateOrder('DSP-1042', SEEDED_USERS.operator);
    expect(receipt.status).toBe('awaiting_approval');
    expect(receipt.calculations.shortfall).toBe(60);
    expect(
      receipt.investigationSteps
        ?.filter((s) => s.tool !== 'get_policy')
        .every((s) => s.sourceId.startsWith('zetaris:'))
    ).toBe(true);
    expect(receipt.sourceRevisions.every((s) => s.backingSystem?.startsWith('zetaris_'))).toBe(
      true
    );
  });

  it('a new stock revision written to the CSV is what Zetaris returns next', async () => {
    await gateway.writeWarehouse({
      ...DEMO_WAREHOUSE,
      revisionId: 'REV-INV-ZETARIS-TEST',
      damaged: 25
    });
    const after = await gateway.lookupInventory('CHR-GOLD-CHIAVARI', ts);
    expect(after.revisionId).toBe('REV-INV-ZETARIS-TEST');
    expect(after.envelope?.data.damaged).toBe(25);
    await gateway.writeWarehouse(DEMO_WAREHOUSE);
    fs.rmSync(scoutDir, { recursive: true, force: true });
  });
});
