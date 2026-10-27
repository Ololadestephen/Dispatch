import type { SyntheticWarehouseRecord } from '../../demo/seedData';
import { DomainError } from '../../domain/errors';

/** Shared column order for the local reader and Zetaris filestore table. */
export const WAREHOUSE_CSV_COLUMNS = [
  'warehouse_id',
  'revision_id',
  'sku',
  'physically_present',
  'damaged',
  'active_allocations',
  'last_audited_iso',
  'is_demo'
] as const;

export const WAREHOUSE_CSV_HEADER = WAREHOUSE_CSV_COLUMNS.join(',');

export type WarehouseCsvColumn = (typeof WAREHOUSE_CSV_COLUMNS)[number];
export type WarehouseCsvRecord = Record<WarehouseCsvColumn, string>;

const NEEDS_QUOTING = /[",\r\n]/;

/** RFC 4180 field encoding: quote only when the value could break the row. */
function encodeField(value: string): string {
  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toWarehouseCsvRecord(warehouse: SyntheticWarehouseRecord): WarehouseCsvRecord {
  return {
    warehouse_id: warehouse.warehouseId,
    revision_id: warehouse.revisionId,
    sku: warehouse.sku,
    physically_present: String(warehouse.physicallyPresent),
    damaged: String(warehouse.damaged),
    active_allocations: String(warehouse.activeAllocations),
    last_audited_iso: warehouse.lastAuditedIso,
    is_demo: String(warehouse.isDemo)
  };
}

export function encodeWarehouseRecords(records: WarehouseCsvRecord[]): string {
  const rows = records.map((record) =>
    WAREHOUSE_CSV_COLUMNS.map((column) => encodeField(record[column])).join(',')
  );
  return `${WAREHOUSE_CSV_HEADER}\n${rows.join('\n')}\n`;
}

export function encodeWarehouseCsv(warehouses: SyntheticWarehouseRecord[]): string {
  return encodeWarehouseRecords(warehouses.map(toWarehouseCsvRecord));
}

/** Splits RFC 4180 CSV into raw fields, honouring quoted commas, quotes and newlines. */
export function splitWarehouseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      fieldStarted = false;
      continue;
    }
    if (char === '\n') {
      row.push(field.endsWith('\r') ? field.slice(0, -1) : field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      continue;
    }
    field += char;
    fieldStarted = true;
  }
  if (quoted) {
    throw new DomainError('Warehouse CSV ends inside a quoted field.', 'SOURCE_UNAVAILABLE');
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parses and validates the Dispatch inventory layout; malformed rows fail loudly. */
export function parseWarehouseCsv(text: string): WarehouseCsvRecord[] {
  const rows = splitWarehouseCsv(text).filter((row) => !(row.length === 1 && row[0] === ''));
  const header = rows.shift();
  if (!header) return [];
  if (header.join(',') !== WAREHOUSE_CSV_HEADER) {
    throw new DomainError(
      `Warehouse CSV header does not match the Dispatch inventory layout: ${header.join(',')}`,
      'SOURCE_UNAVAILABLE'
    );
  }
  return rows.map((row, index) => {
    if (row.length !== WAREHOUSE_CSV_COLUMNS.length) {
      throw new DomainError(
        `Warehouse CSV row ${index + 2} has ${row.length} columns; expected ${WAREHOUSE_CSV_COLUMNS.length}.`,
        'SOURCE_UNAVAILABLE'
      );
    }
    const record = {} as WarehouseCsvRecord;
    WAREHOUSE_CSV_COLUMNS.forEach((column, position) => {
      record[column] = row[position]!;
    });
    return record;
  });
}
