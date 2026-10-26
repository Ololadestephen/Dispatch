import {
  SyntheticOrderRecord,
  SyntheticWarehouseRecord,
  SyntheticInboundShipmentRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticBackupListingRecord
} from '../../demo/seedData';
import { ApprovalPolicy } from '../../domain/policy';

export type SourceType =
  | 'orders'
  | 'inventory'
  | 'inbound_shipments'
  | 'supplier_updates'
  | 'backup_listings';

/** Where a record physically lives. The zetaris_* values mean it was read through Zetaris. */
export type BackingSystem =
  | 'relational_sql'
  | 'filesystem_csv'
  | 'document_store'
  | 'zetaris_jdbc_postgresql'
  | 'zetaris_filestore_csv'
  | 'zetaris_filestore_json';

/** local_files: Dispatch reads local files itself. zetaris: every read is a Zetaris SQL query. */
export type ProviderMode = 'local_files' | 'zetaris';

/** Where each source type is read from, for envelopes and the UI. */
export type SourceLocations = Record<
  SourceType,
  { sourceId: string; backingSystem: BackingSystem }
>;

/** Reads one record per lookup. Throws DomainError('SOURCE_UNAVAILABLE') when a source cannot be read. */
export interface SourceReader {
  readonly providerMode: ProviderMode;
  readonly locations: SourceLocations;
  readOrder(orderId: string, signal?: AbortSignal): Promise<SyntheticOrderRecord | undefined>;
  readInventory(sku: string, signal?: AbortSignal): Promise<SyntheticWarehouseRecord | undefined>;
  readInbound(
    sku: string,
    signal?: AbortSignal
  ): Promise<SyntheticInboundShipmentRecord | undefined>;
  readSupplierMessage(
    orderId: string,
    signal?: AbortSignal
  ): Promise<SyntheticSupplierUpdateRecord | undefined>;
  readBackupListing(
    sku: string,
    signal?: AbortSignal
  ): Promise<SyntheticBackupListingRecord | undefined>;
}

export interface SourceSeed {
  order: SyntheticOrderRecord;
  warehouse: SyntheticWarehouseRecord;
  inboundShipment?: SyntheticInboundShipmentRecord;
  supplierMessage: SyntheticSupplierUpdateRecord;
  backupListing?: SyntheticBackupListingRecord | null;
}

/** Writes to the backing systems themselves (seed, reset, new source revisions). */
export interface SourceWriter {
  isSeeded(): Promise<boolean>;
  seed(seed: SourceSeed): Promise<void>;
  writeWarehouse(record: SyntheticWarehouseRecord): Promise<void>;
  writeSupplierMessage(record: SyntheticSupplierUpdateRecord): Promise<void>;
}

export interface SourceRecordEnvelope<T> {
  sourceId: string;
  sourceType: SourceType;
  backingSystem: BackingSystem;
  recordId: string;
  revisionId: string;
  timestampIso: string;
  snapshotHash: string;
  data: T;
}

export interface EvidenceSnapshot {
  snapshotId: string;
  capturedAtIso: string;
  providerMode: ProviderMode;
  sources: {
    orders: SourceRecordEnvelope<SyntheticOrderRecord>;
    inventory: SourceRecordEnvelope<SyntheticWarehouseRecord>;
    inboundShipments?: SourceRecordEnvelope<SyntheticInboundShipmentRecord>;
    supplierUpdates: SourceRecordEnvelope<SyntheticSupplierUpdateRecord>;
    backupListing?: SourceRecordEnvelope<SyntheticBackupListingRecord>;
  };
  topology: {
    distinctBackingSystemsCount: number;
    backingSystems: string[];
    isMultiSourceCompliant: boolean;
  };
}

export interface AllowlistedLookupExecution<T = unknown> {
  tool:
    | 'get_order'
    | 'get_inventory'
    | 'get_inbound'
    | 'get_supplier_messages'
    | 'get_backup_listings'
    | 'get_policy';
  args: Record<string, string>;
  sourceId: string;
  revisionId: string;
  recordId: string;
  snapshotHash: string;
  status: 'ok' | 'missing' | 'error';
  outcomeSummary: string;
  envelope?: SourceRecordEnvelope<T>;
  policy?: ApprovalPolicy;
}
