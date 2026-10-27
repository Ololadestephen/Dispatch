import type {
  SyntheticBackupListingRecord,
  SyntheticInboundShipmentRecord,
  SyntheticOrderRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticWarehouseRecord
} from '../../demo/seedData';
import { DomainError } from '../../domain/errors';
import type { SourceLocations, SourceReader } from '../sources/types';
import { ZETARIS_DATASOURCE, ZETARIS_FILES_DB } from './backingStores';
import { sqlString, ZetarisClient } from './client';
import {
  OrderSourceSchema,
  InboundSourceSchema,
  InventorySourceSchema,
  SupplierSourceSchema,
  BackupSourceSchema,
  parseSourceRecord,
  sourceInteger
} from '../sources/schemas';

type Row = Record<string, string | null>;

/** Ids are interpolated into SQL, so only this shape is accepted (no quotes, spaces or comments). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function safeId(value: string, what: string): string {
  if (!SAFE_ID.test(value)) {
    throw new DomainError(
      `Refusing to query Zetaris with unsafe ${what} "${value}".`,
      'INVALID_REQUEST'
    );
  }
  return sqlString(value);
}

function str(row: Row, column: string): string {
  const v = row[column];
  if (v === null || v === undefined) {
    throw new DomainError(`Zetaris row is missing column ${column}.`, 'SOURCE_UNAVAILABLE');
  }
  return v;
}

/** Zetaris returns every value as a string; quantities must parse as whole numbers. */
function int(row: Row, column: string): number {
  return sourceInteger(str(row, column), `Zetaris column ${column}`);
}

function orderFromRow(row: Row): SyntheticOrderRecord {
  return parseSourceRecord(
    OrderSourceSchema,
    {
      orderId: str(row, 'order_id'),
      revisionId: str(row, 'revision_id'),
      customerName: str(row, 'customer_name'),
      eventName: str(row, 'event_name'),
      deliveryLocation: str(row, 'delivery_location'),
      deliveryDeadlineIso: str(row, 'delivery_deadline_iso'),
      sku: str(row, 'sku'),
      itemDescription: str(row, 'item_description'),
      requiredQuantity: int(row, 'required_quantity'),
      operationalStatus: str(row, 'operational_status'),
      isDemo: true
    },
    'Zetaris order'
  );
}

function inboundFromRow(row: Row): SyntheticInboundShipmentRecord {
  return parseSourceRecord(
    InboundSourceSchema,
    {
      shipmentId: str(row, 'shipment_id'),
      revisionId: str(row, 'revision_id'),
      orderId: str(row, 'order_id'),
      supplierName: str(row, 'supplier_name'),
      sku: str(row, 'sku'),
      originallyExpectedQuantity: int(row, 'originally_expected_quantity'),
      originalPromisedArrivalIso: str(row, 'original_promised_arrival_iso'),
      status: str(row, 'status'),
      isDemo: true
    },
    'Zetaris inbound shipment'
  );
}

function inventoryFromRow(row: Row): SyntheticWarehouseRecord {
  return parseSourceRecord(
    InventorySourceSchema,
    {
      warehouseId: str(row, 'warehouse_id'),
      revisionId: str(row, 'revision_id'),
      sku: str(row, 'sku'),
      physicallyPresent: int(row, 'physically_present'),
      damaged: int(row, 'damaged'),
      activeAllocations: int(row, 'active_allocations'),
      lastAuditedIso: str(row, 'last_audited_iso'),
      isDemo: true
    },
    'Zetaris inventory'
  );
}

function supplierMessageFromRow(row: Row): SyntheticSupplierUpdateRecord {
  return parseSourceRecord(
    SupplierSourceSchema,
    {
      messageId: str(row, 'messageId'),
      revisionId: str(row, 'revisionId'),
      orderId: str(row, 'orderId'),
      supplierName: str(row, 'supplierName'),
      rawMessageText: str(row, 'rawMessageText'),
      receivedAtIso: str(row, 'receivedAtIso'),
      isDemo: true
    },
    'Zetaris supplier message'
  );
}

function backupListingFromRow(row: Row): SyntheticBackupListingRecord {
  return parseSourceRecord(
    BackupSourceSchema,
    {
      listingId: str(row, 'listingId'),
      revisionId: str(row, 'revisionId'),
      supplierName: str(row, 'supplierName'),
      sku: str(row, 'sku'),
      availableQuantity: int(row, 'availableQuantity'),
      statedDeliveryArrivalIso: str(row, 'statedDeliveryArrivalIso'),
      costKobo: int(row, 'costKobo'),
      isConfirmedReservation: false,
      listedAtIso: str(row, 'listedAtIso'),
      isDemo: true
    },
    'Zetaris backup listing'
  );
}

const T = {
  orders: `${ZETARIS_DATASOURCE}.orders`,
  inbound: `${ZETARIS_DATASOURCE}.inbound_shipments`,
  inventory: `${ZETARIS_FILES_DB}.warehouse_inventory`,
  supplier: `${ZETARIS_FILES_DB}.supplier_messages`,
  backup: `${ZETARIS_FILES_DB}.backup_listings`
};

/** Every Dispatch source read is a Zetaris SQL query over the federated PostgreSQL + file tables. */
export class ZetarisReader implements SourceReader {
  readonly providerMode = 'zetaris' as const;
  readonly locations: SourceLocations = {
    orders: { sourceId: `zetaris:${T.orders}`, backingSystem: 'zetaris_jdbc_postgresql' },
    inbound_shipments: {
      sourceId: `zetaris:${T.inbound}`,
      backingSystem: 'zetaris_jdbc_postgresql'
    },
    inventory: { sourceId: `zetaris:${T.inventory}`, backingSystem: 'zetaris_filestore_csv' },
    supplier_updates: {
      sourceId: `zetaris:${T.supplier}`,
      backingSystem: 'zetaris_filestore_json'
    },
    backup_listings: { sourceId: `zetaris:${T.backup}`, backingSystem: 'zetaris_filestore_json' }
  };

  constructor(private readonly client: ZetarisClient) {}

  async readOrders(signal?: AbortSignal): Promise<SyntheticOrderRecord[]> {
    const rows = await this.client.query(
      `SELECT * FROM ${T.orders} ORDER BY order_id ASC`,
      1000,
      signal
    );
    return rows.rows.map(orderFromRow);
  }

  async readOrder(
    orderId: string,
    signal?: AbortSignal
  ): Promise<SyntheticOrderRecord | undefined> {
    const row = await this.one(
      `SELECT * FROM ${T.orders} WHERE order_id = ${safeId(orderId, 'order id')}`,
      signal
    );
    return row ? orderFromRow(row) : undefined;
  }

  async readInbound(
    sku: string,
    orderId?: string,
    signal?: AbortSignal
  ): Promise<SyntheticInboundShipmentRecord | undefined> {
    const filter = orderId ? ` AND order_id = ${safeId(orderId, 'order id')}` : '';
    const row = await this.one(
      `SELECT * FROM ${T.inbound} WHERE sku = ${safeId(sku, 'SKU')}${filter}`,
      signal
    );
    return row ? inboundFromRow(row) : undefined;
  }

  async readInventory(
    sku: string,
    signal?: AbortSignal
  ): Promise<SyntheticWarehouseRecord | undefined> {
    const row = await this.one(
      `SELECT * FROM ${T.inventory} WHERE sku = ${safeId(sku, 'SKU')}`,
      signal
    );
    return row ? inventoryFromRow(row) : undefined;
  }

  async readSupplierMessage(
    orderId: string,
    signal?: AbortSignal
  ): Promise<SyntheticSupplierUpdateRecord | undefined> {
    const row = await this.one(
      `SELECT * FROM ${T.supplier} WHERE orderId = ${safeId(orderId, 'order id')}`,
      signal
    );
    return row ? supplierMessageFromRow(row) : undefined;
  }

  async readBackupListings(
    sku: string,
    signal?: AbortSignal
  ): Promise<SyntheticBackupListingRecord[]> {
    const { rows } = await this.client.query(
      `SELECT * FROM ${T.backup} WHERE sku = ${safeId(sku, 'SKU')}`,
      1000,
      signal
    );
    return rows.map(backupListingFromRow).sort((a, b) => {
      const byArrival =
        Date.parse(a.statedDeliveryArrivalIso) - Date.parse(b.statedDeliveryArrivalIso);
      return Number.isNaN(byArrival) || byArrival === 0
        ? a.listingId.localeCompare(b.listingId)
        : byArrival;
    });
  }

  /** A lookup must match at most one record; more is ambiguous evidence. */
  private async one(sql: string, signal?: AbortSignal): Promise<Row | undefined> {
    const { rows } = await this.client.query(sql, 2, signal);
    if (rows.length > 1) {
      throw new DomainError(
        `Zetaris returned ${rows.length} rows for a single-record lookup.`,
        'SOURCE_UNAVAILABLE'
      );
    }
    return rows[0];
  }
}
