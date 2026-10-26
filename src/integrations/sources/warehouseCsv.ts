import type { SyntheticWarehouseRecord } from '../../demo/seedData';

/** Shared column order for the local reader and Zetaris filestore table. */
export function encodeWarehouseCsv(warehouse: SyntheticWarehouseRecord): string {
  const header =
    'warehouse_id,revision_id,sku,physically_present,damaged,active_allocations,last_audited_iso,is_demo';
  const row = [
    warehouse.warehouseId,
    warehouse.revisionId,
    warehouse.sku,
    warehouse.physicallyPresent,
    warehouse.damaged,
    warehouse.activeAllocations,
    warehouse.lastAuditedIso,
    warehouse.isDemo
  ].join(',');
  return `${header}\n${row}\n`;
}
