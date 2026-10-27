import { describe, expect, it } from 'vitest';
import {
  BACKING_SYSTEM_LABELS,
  LOOKUP_LABELS,
  SOURCE_LABELS,
  shortHash,
  sourceTable
} from '../../src/client/format';

describe('desk display labels', () => {
  it('labels every source and lookup type', () => {
    expect(SOURCE_LABELS.orders).toBe('Order');
    expect(SOURCE_LABELS.backup_listings).toBe('Backup listing');
    expect(LOOKUP_LABELS.get_policy).toBe('Spend policy');
    expect(LOOKUP_LABELS.get_backup_listings).toBe('Backup listings');
  });

  it('names local and Zetaris backing systems', () => {
    expect(BACKING_SYSTEM_LABELS.filesystem_csv).toBe('Local CSV');
    expect(BACKING_SYSTEM_LABELS.zetaris_jdbc_postgresql).toBe('PostgreSQL via Zetaris');
    expect(BACKING_SYSTEM_LABELS.zetaris_filestore_json).toBe('JSON file table via Zetaris');
  });

  it('strips only the provider prefixes from a source id', () => {
    expect(sourceTable('zetaris:DISPATCH_FILES.warehouse_inventory')).toBe(
      'DISPATCH_FILES.warehouse_inventory'
    );
    expect(sourceTable('local:warehouse_inventory.csv')).toBe('warehouse_inventory.csv');
    expect(sourceTable('app:orders')).toBe('orders');
    expect(sourceTable('orders')).toBe('orders');
    expect(sourceTable('other:orders')).toBe('other:orders');
  });

  it('shortens a hash for display and handles a missing hash', () => {
    expect(shortHash('0123456789abcdef')).toBe('0123456789');
    expect(shortHash(undefined)).toBe('—');
    expect(shortHash('')).toBe('—');
  });
});
