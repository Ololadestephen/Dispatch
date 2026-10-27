import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { createSourceGateway, LocalFileStore, SourceGateway } from '../../src/integrations/sources';
import { ZetarisReader } from '../../src/integrations/zetaris/reader';
import type { ZetarisClient, ZetarisQueryResult } from '../../src/integrations/zetaris/client';
import { DomainError } from '../../src/domain/errors';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT
} from '../../src/demo/seedData';
import { FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';
import { runTmp } from '../support/runRoot';
import {
  encodeWarehouseRecords,
  toWarehouseCsvRecord
} from '../../src/integrations/sources/warehouseCsv';

const SEED = {
  orders: [DEMO_ORDER],
  warehouses: [DEMO_WAREHOUSE],
  supplierMessages: [DEMO_SUPPLIER_MESSAGE],
  backupListings: [DEMO_BACKUP_LISTING],
  inboundShipments: [DEMO_INBOUND_SHIPMENT]
};
const ts = FROZEN_SCENARIO_TIME_ISO;

describe('Local-files source gateway', () => {
  const dir = runTmp('sources_local');
  let gateway: SourceGateway;

  beforeEach(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const store = new LocalFileStore(dir);
    gateway = new SourceGateway(store, store);
    await gateway.seed(SEED);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the six lookups and labels the snapshot as local files', async () => {
    expect((await gateway.lookupOrder('DSP-1042', ts)).revisionId).toBe(DEMO_ORDER.revisionId);
    expect((await gateway.lookupInventory('CHR-GOLD-CHIAVARI', ts)).snapshotHash).toHaveLength(64);
    expect((await gateway.lookupInbound('CHR-GOLD-CHIAVARI', ts)).status).toBe('ok');
    expect((await gateway.lookupSupplierMessages('DSP-1042', ts)).status).toBe('ok');
    expect((await gateway.lookupBackupListings('CHR-GOLD-CHIAVARI', ts)).status).toBe('ok');
    expect((await gateway.lookupPolicy('emergency_spend')).outcomeSummary).toContain(
      'manager approval'
    );

    const snapshot = await gateway.fetchEvidenceSnapshot('DSP-1042', ts);
    expect(snapshot.providerMode).toBe('local_files');
    expect(snapshot.sources.orders.sourceId).toMatch(/^local:/);
    const msg = snapshot.sources.supplierUpdates.data as unknown as Record<string, unknown>;
    expect(typeof msg.rawMessageText).toBe('string');
    expect(msg.revisedArrivalIso).toBeUndefined();
  });

  it('a new revision changes the record hash', async () => {
    const before = await gateway.lookupInventory('CHR-GOLD-CHIAVARI', ts);
    await gateway.writeWarehouse({ ...DEMO_WAREHOUSE, revisionId: 'REV-INV-NEW', damaged: 25 });
    const after = await gateway.lookupInventory('CHR-GOLD-CHIAVARI', ts);
    expect(after.revisionId).toBe('REV-INV-NEW');
    expect(after.snapshotHash).not.toBe(before.snapshotHash);
  });

  it.each([{ wrong: 'shape' }, [{ ...DEMO_SUPPLIER_MESSAGE, rawMessageText: 123 }]])(
    'reports malformed supplier records as unavailable sources',
    async (payload) => {
      fs.writeFileSync(path.join(dir, 'supplier_messages.json'), JSON.stringify(payload));
      const lookup = await gateway.lookupSupplierMessages('DSP-1042', ts);
      expect(lookup.status).toBe('error');
      expect(lookup.envelope).toBeUndefined();
      await expect(gateway.fetchEvidenceSnapshot('DSP-1042', ts)).rejects.toMatchObject({
        code: 'SOURCE_UNAVAILABLE'
      });
    }
  );

  it('rewrites only the matching inventory row when a stored field contains a comma', async () => {
    const file = path.join(dir, 'warehouse_inventory.csv');
    const quoted = { ...DEMO_WAREHOUSE, warehouseId: 'WH,"LAG,MAIN"', revisionId: 'REV-INV-2' };
    fs.writeFileSync(file, encodeWarehouseRecords([toWarehouseCsvRecord(quoted)]));
    await gateway.writeWarehouse({ ...quoted, revisionId: 'REV-INV-3', damaged: 25 });

    const csv = fs.readFileSync(file, 'utf8');
    expect(csv).toContain('"WH,""LAG,MAIN"""');
    await expect(new LocalFileStore(dir).readInventory(DEMO_ORDER.sku)).resolves.toMatchObject({
      warehouseId: 'WH,"LAG,MAIN"',
      revisionId: 'REV-INV-3',
      damaged: 25
    });
  });

  it('reports an unreadable inventory file as an error lookup', async () => {
    const file = path.join(dir, 'warehouse_inventory.csv');
    fs.rmSync(file);
    fs.mkdirSync(file);
    const lookup = await gateway.lookupInventory(DEMO_ORDER.sku, ts);
    expect(lookup.status).toBe('error');
    expect(lookup.envelope).toBeUndefined();
  });

  it('reports a corrupt source database as an error lookup', async () => {
    fs.writeFileSync(path.join(dir, 'orders.sqlite'), 'not a SQLite database');
    const lookup = await gateway.lookupOrder('DSP-1042', ts);
    expect(lookup.status).toBe('error');
    expect(lookup.envelope).toBeUndefined();
  });
});

/** Returns canned rows per table, recording the SQL it was given. */
function stubClient(tables: Record<string, Array<Record<string, string>>>) {
  const queries: string[] = [];
  const client = {
    async query(sql: string): Promise<ZetarisQueryResult> {
      queries.push(sql);
      const table = Object.keys(tables).find((t) => sql.includes(`FROM ${t} `));
      return { rows: table ? tables[table]! : [] };
    }
  } as unknown as ZetarisClient;
  return { client, queries };
}

describe('Zetaris source reader', () => {
  const orderRow = {
    order_id: 'DSP-1042',
    revision_id: 'REV-ORD-20261021-01',
    customer_name: 'Mrs. Folashade Adeyemi',
    event_name: 'Adeyemi Wedding Ceremony',
    delivery_location: 'Landmark Centre, Victoria Island, Lagos',
    delivery_deadline_iso: '2026-10-24T09:00:00+01:00',
    sku: 'CHR-GOLD-CHIAVARI',
    item_description: 'Gold Chiavari Banquet Chair',
    required_quantity: '120',
    operational_status: 'confirmed',
    is_demo: 'true'
  };

  it('reads through Zetaris tables and parses string values into typed records', async () => {
    const { client, queries } = stubClient({ 'DISPATCH_ORDERS_PG.orders': [orderRow] });
    const reader = new ZetarisReader(client);
    const store = new LocalFileStore('/nonexistent');
    const gateway = new SourceGateway(reader, store);

    const lookup = await gateway.lookupOrder('DSP-1042', ts);
    expect(lookup.status).toBe('ok');
    expect(lookup.envelope?.data.requiredQuantity).toBe(120);
    expect(lookup.sourceId).toBe('zetaris:DISPATCH_ORDERS_PG.orders');
    expect(lookup.envelope?.backingSystem).toBe('zetaris_jdbc_postgresql');
    expect(queries[0]).toBe("SELECT * FROM DISPATCH_ORDERS_PG.orders WHERE order_id = 'DSP-1042'");
  });

  it.each([
    { operational_status: 'supplier_says_delivered' },
    { required_quantity: '' },
    { required_quantity: '-1' }
  ])(
    'refuses invalid Zetaris order fields before producing an evidence envelope',
    async (changes) => {
      const { client } = stubClient({ 'DISPATCH_ORDERS_PG.orders': [{ ...orderRow, ...changes }] });
      const gateway = new SourceGateway(
        new ZetarisReader(client),
        new LocalFileStore('/nonexistent')
      );
      const lookup = await gateway.lookupOrder('DSP-1042', ts);
      expect(lookup.status).toBe('error');
      expect(lookup.envelope).toBeUndefined();
    }
  );

  it('refuses unsafe ids before building SQL', async () => {
    const { client, queries } = stubClient({});
    await expect(new ZetarisReader(client).readOrder("x' OR '1'='1")).rejects.toThrow(/unsafe/);
    expect(queries).toHaveLength(0);
  });

  it('an unreachable Zetaris is an error lookup, never local data', async () => {
    const client = {
      async query(): Promise<ZetarisQueryResult> {
        throw new DomainError('Cannot reach Zetaris', 'SOURCE_UNAVAILABLE');
      }
    } as unknown as ZetarisClient;
    const store = new LocalFileStore(runTmp('sources_unused'));
    await store.seed(SEED);
    const gateway = new SourceGateway(new ZetarisReader(client), store);
    const lookup = await gateway.lookupOrder('DSP-1042', ts);
    expect(lookup.status).toBe('error');
    expect(lookup.envelope).toBeUndefined();
    await expect(gateway.fetchEvidenceSnapshot('DSP-1042', ts)).rejects.toThrow(
      /Cannot reach Zetaris/
    );
    fs.rmSync(runTmp('sources_unused'), { recursive: true, force: true });
  });

  it('a misconfigured Zetaris mode fails at startup instead of switching to local files', () => {
    expect(() => createSourceGateway('/tmp/x', { DISPATCH_SOURCES: 'zetaris' })).toThrow(
      /needs ZETARIS_BASE_URL/
    );
    expect(() => createSourceGateway('/tmp/x', { DISPATCH_SOURCES: 'sometimes' })).toThrow(
      /must be/
    );
  });
});
