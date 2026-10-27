import { describe, expect, it } from 'vitest';
import {
  WAREHOUSE_CSV_HEADER,
  encodeWarehouseCsv,
  encodeWarehouseRecords,
  parseWarehouseCsv,
  splitWarehouseCsv,
  toWarehouseCsvRecord
} from '../../src/integrations/sources/warehouseCsv';
import type { SyntheticWarehouseRecord } from '../../src/demo/seedData';
import { DomainError } from '../../src/domain/errors';

const warehouse = (
  overrides: Partial<SyntheticWarehouseRecord> = {}
): SyntheticWarehouseRecord => ({
  warehouseId: 'WH-LAG-01',
  revisionId: 'REV-WH-1',
  sku: 'CHR-GOLD-CHIAVARI',
  physicallyPresent: 80,
  damaged: 20,
  activeAllocations: 0,
  lastAuditedIso: '2026-10-24T08:00:00+01:00',
  isDemo: true,
  ...overrides
});

describe('warehouse CSV codec', () => {
  it('round-trips a plain record', () => {
    const csv = encodeWarehouseCsv([warehouse()]);
    expect(csv.split('\n')[0]).toBe(WAREHOUSE_CSV_HEADER);
    expect(parseWarehouseCsv(csv)).toEqual([toWarehouseCsvRecord(warehouse())]);
  });

  it('quotes and restores a value that contains a comma', () => {
    const record = warehouse({ sku: 'CHR-GOLD,CHIAVARI' });
    const csv = encodeWarehouseCsv([record]);
    expect(csv).toContain('"CHR-GOLD,CHIAVARI"');
    expect(parseWarehouseCsv(csv)).toEqual([toWarehouseCsvRecord(record)]);
  });

  it('escapes embedded quotes and newlines', () => {
    const record = warehouse({ warehouseId: 'WH-"QUOTED"' });
    const csv = encodeWarehouseRecords([
      { ...toWarehouseCsvRecord(record), revision_id: 'REV\nLINE' }
    ]);
    expect(csv).toContain('"WH-""QUOTED"""');
    const [parsed] = parseWarehouseCsv(csv);
    expect(parsed).toMatchObject({ warehouse_id: 'WH-"QUOTED"', revision_id: 'REV\nLINE' });
  });

  it('accepts CRLF row endings and a trailing newline', () => {
    const text = `${WAREHOUSE_CSV_HEADER}\r\nWH-1,REV-1,SKU-1,1,0,0,2026-10-24T08:00:00+01:00,true\r\n`;
    expect(parseWarehouseCsv(text)).toHaveLength(1);
  });

  it('returns no records for an empty file', () => {
    expect(parseWarehouseCsv('')).toEqual([]);
  });

  it('rejects a header that is not the Dispatch inventory layout', () => {
    expect(() => parseWarehouseCsv('a,b,c\n1,2,3\n')).toThrow(DomainError);
    try {
      parseWarehouseCsv('a,b,c\n1,2,3\n');
    } catch (err) {
      expect((err as DomainError).code).toBe('SOURCE_UNAVAILABLE');
    }
  });

  it('rejects a row with the wrong number of columns instead of shifting values', () => {
    const text = `${WAREHOUSE_CSV_HEADER}\nWH-1,REV-1,SKU-1,1,0,0\n`;
    expect(() => parseWarehouseCsv(text)).toThrow(/row 2 has 6 columns; expected 8/);
  });

  it('rejects a file that ends inside a quoted field', () => {
    expect(() => splitWarehouseCsv(`${WAREHOUSE_CSV_HEADER}\n"WH-1`)).toThrow(
      /ends inside a quoted field/
    );
  });

  it('keeps every field when a quoted value contains the delimiter', () => {
    expect(splitWarehouseCsv('a,"b,c",d\n')).toEqual([['a', 'b,c', 'd']]);
    expect(splitWarehouseCsv('a,"b""c",d\n')).toEqual([['a', 'b"c', 'd']]);
  });
});
