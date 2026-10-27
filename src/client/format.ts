import { formatNaira } from '../domain/policy';
import type { AllowlistedLookupTool, SourceType } from '../domain/receipt';

export { formatNaira };
export { formatWat, weekdayWat } from '../domain/time';

export const SOURCE_LABELS: Record<SourceType, string> = {
  orders: 'Order',
  inventory: 'Warehouse stock',
  inbound_shipments: 'Inbound shipment',
  supplier_updates: 'Supplier message',
  backup_listings: 'Backup listing'
};

export const LOOKUP_LABELS: Record<AllowlistedLookupTool, string> = {
  get_order: 'Order',
  get_inventory: 'Warehouse stock',
  get_inbound: 'Inbound shipment',
  get_supplier_messages: 'Supplier messages',
  get_backup_listings: 'Backup listings',
  get_policy: 'Spend policy'
};

export const BACKING_SYSTEM_LABELS: Record<string, string> = {
  relational_sql: 'Local SQLite',
  filesystem_csv: 'Local CSV',
  document_store: 'Local JSON',
  zetaris_jdbc_postgresql: 'PostgreSQL via Zetaris',
  zetaris_filestore_csv: 'CSV file table via Zetaris',
  zetaris_filestore_json: 'JSON file table via Zetaris'
};

/** "zetaris:DISPATCH_FILES.warehouse_inventory" -> "DISPATCH_FILES.warehouse_inventory". */
export function sourceTable(sourceId: string): string {
  return sourceId.replace(/^(zetaris|local|app):/, '');
}

export function shortHash(hash: string | undefined): string {
  return hash ? hash.slice(0, 10) : '—';
}
