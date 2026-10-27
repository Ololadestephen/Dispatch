import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BackingStores,
  type BackingStoreConfig
} from '../../src/integrations/zetaris/backingStores';
import { encodeWarehouseCsv, parseWarehouseCsv } from '../../src/integrations/sources/warehouseCsv';
import { DEMO_SUPPLIER_MESSAGE, DEMO_WAREHOUSE } from '../../src/demo/seedData';
import { runTmp } from '../support/runRoot';

const dir = runTmp('backing_stores');

const config: BackingStoreConfig = {
  pg: { host: '127.0.0.1', port: 1, database: 'unused', user: 'unused', password: 'unused' },
  filesDir: dir,
  filesPathInZetaris: '/unused',
  jdbcUrlFromZetaris: 'jdbc:postgresql://unused:5432/unused'
};

const inventoryFile = path.join(dir, 'warehouse_inventory.csv');
const supplierFile = path.join(dir, 'supplier_messages.json');

const stores = new BackingStores(config);

beforeEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});

describe('Zetaris file backing store writes', () => {
  it('rewrites only the matching warehouse row and preserves quoted fields', async () => {
    const other = { ...DEMO_WAREHOUSE, sku: 'TBL-ROUND-72', warehouseId: 'WHS-LOS-02' };
    fs.writeFileSync(
      inventoryFile,
      encodeWarehouseCsv([{ ...DEMO_WAREHOUSE, warehouseId: 'WH,"A"' }, other])
    );

    await stores.writeWarehouse({
      ...DEMO_WAREHOUSE,
      warehouseId: 'WH,"A"',
      revisionId: 'REV-NEW',
      damaged: 25
    });

    const rows = parseWarehouseCsv(fs.readFileSync(inventoryFile, 'utf8'));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      warehouse_id: 'WH,"A"',
      revision_id: 'REV-NEW',
      damaged: '25'
    });
    expect(rows[1]).toMatchObject({ warehouse_id: 'WHS-LOS-02', sku: 'TBL-ROUND-72' });
    expect(fs.readFileSync(inventoryFile, 'utf8')).toContain('"WH,""A"""');
  });

  it('appends a new SKU without dropping existing rows', async () => {
    fs.writeFileSync(inventoryFile, encodeWarehouseCsv([DEMO_WAREHOUSE]));
    const linen = { ...DEMO_WAREHOUSE, sku: 'LIN-IVORY-120' };
    await stores.writeWarehouse(linen);
    const rows = parseWarehouseCsv(fs.readFileSync(inventoryFile, 'utf8'));
    expect(rows.map((row) => row.sku)).toEqual(['CHR-GOLD-CHIAVARI', 'LIN-IVORY-120']);
  });

  it('rejects a malformed inventory header instead of rewriting positional columns', async () => {
    fs.writeFileSync(inventoryFile, 'warehouse,revision\nWH-1,REV-1\n');
    await expect(stores.writeWarehouse(DEMO_WAREHOUSE)).rejects.toMatchObject({
      code: 'SOURCE_UNAVAILABLE'
    });
    expect(fs.readFileSync(inventoryFile, 'utf8')).toBe('warehouse,revision\nWH-1,REV-1\n');
  });

  it('replaces one supplier message and preserves the other lines', async () => {
    const other = { ...DEMO_SUPPLIER_MESSAGE, messageId: 'MSG-OTHER', orderId: 'DSP-1043' };
    fs.writeFileSync(
      supplierFile,
      [DEMO_SUPPLIER_MESSAGE, other].map((record) => JSON.stringify(record)).join('\n') + '\n'
    );

    await stores.writeSupplierMessage({
      ...DEMO_SUPPLIER_MESSAGE,
      revisionId: 'REV-SUP-NEW',
      rawMessageText: 'Updated text'
    });

    const lines = JSON.parse(fs.readFileSync(supplierFile, 'utf8')) as Array<{
      messageId: string;
      orderId: string;
      revisionId: string;
    }>;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      messageId: 'MSG-SUP-8821',
      revisionId: 'REV-SUP-NEW',
      orderId: 'DSP-1042'
    });
    expect(lines[1]).toMatchObject({ messageId: 'MSG-OTHER', orderId: 'DSP-1043' });
  });

  it('appends a new supplier message', async () => {
    fs.writeFileSync(supplierFile, JSON.stringify(DEMO_SUPPLIER_MESSAGE) + '\n');
    const other = { ...DEMO_SUPPLIER_MESSAGE, messageId: 'MSG-OTHER', orderId: 'DSP-1043' };
    await stores.writeSupplierMessage(other);
    const lines = JSON.parse(fs.readFileSync(supplierFile, 'utf8')) as Array<{ orderId: string }>;
    expect(lines.map((line) => line.orderId)).toEqual(['DSP-1042', 'DSP-1043']);
  });

  it('revises an array document without dropping another supplier record', async () => {
    const other = { ...DEMO_SUPPLIER_MESSAGE, messageId: 'MSG-OTHER', orderId: 'DSP-1043' };
    fs.writeFileSync(supplierFile, JSON.stringify([DEMO_SUPPLIER_MESSAGE, other]));
    await stores.writeSupplierMessage({ ...DEMO_SUPPLIER_MESSAGE, revisionId: 'REV-ARRAY' });
    const records = JSON.parse(fs.readFileSync(supplierFile, 'utf8')) as unknown[];
    expect(records).toEqual([{ ...DEMO_SUPPLIER_MESSAGE, revisionId: 'REV-ARRAY' }, other]);
  });

  it('reports a corrupt stored message line with its position and code', async () => {
    fs.writeFileSync(supplierFile, `${JSON.stringify(DEMO_SUPPLIER_MESSAGE)}\n{"broken":\n`);
    await expect(
      stores.writeSupplierMessage({ ...DEMO_SUPPLIER_MESSAGE, revisionId: 'REV-NEW' })
    ).rejects.toMatchObject({ code: 'STORED_RECORD_CORRUPT' });
    expect(fs.readFileSync(supplierFile, 'utf8')).toContain('{"broken":');
  });
});
