import { encodeWarehouseCsv, parseWarehouseCsv } from './warehouseCsv';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type {
  SyntheticBackupListingRecord,
  SyntheticInboundShipmentRecord,
  SyntheticOrderRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticWarehouseRecord
} from '../../demo/seedData';
import { DomainError } from '../../domain/errors';
import { parseJsonOrThrow } from '../../domain/json';
import type { SourceLocations, SourceReader, SourceSeed, SourceWriter } from './types';
import {
  OrderSourceSchema,
  InboundSourceSchema,
  InventorySourceSchema,
  SupplierSourceSchema,
  BackupSourceSchema,
  parseSourceRecord,
  sourceInteger
} from './schemas';

/**
 * Local-files mode: Dispatch reads a SQLite file, a CSV file and two JSON files itself.
 * No data platform is involved. Used offline (tests, `npm run dev:mock`) and labelled so.
 */
export class LocalFileStore implements SourceReader, SourceWriter {
  readonly providerMode = 'local_files' as const;
  readonly locations: SourceLocations = {
    orders: { sourceId: 'local:orders.sqlite#orders', backingSystem: 'relational_sql' },
    inbound_shipments: {
      sourceId: 'local:orders.sqlite#inbound_shipments',
      backingSystem: 'relational_sql'
    },
    inventory: { sourceId: 'local:warehouse_inventory.csv', backingSystem: 'filesystem_csv' },
    supplier_updates: { sourceId: 'local:supplier_messages.json', backingSystem: 'document_store' },
    backup_listings: { sourceId: 'local:backup_listings.json', backingSystem: 'document_store' }
  };

  private readonly sqlitePath: string;
  private readonly inventoryPath: string;
  private readonly supplierPath: string;
  private readonly backupPath: string;

  constructor(private readonly dataDir: string) {
    this.sqlitePath = path.join(dataDir, 'orders.sqlite');
    this.inventoryPath = path.join(dataDir, 'warehouse_inventory.csv');
    this.supplierPath = path.join(dataDir, 'supplier_messages.json');
    this.backupPath = path.join(dataDir, 'backup_listings.json');
  }

  async isSeeded(): Promise<boolean> {
    return [this.sqlitePath, this.inventoryPath, this.supplierPath, this.backupPath].every((p) =>
      fs.existsSync(p)
    );
  }

  async seed(seed: SourceSeed): Promise<void> {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.sqlitePath);
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, customer_name TEXT NOT NULL,
          event_name TEXT NOT NULL, delivery_location TEXT NOT NULL, delivery_deadline_iso TEXT NOT NULL,
          sku TEXT NOT NULL, item_description TEXT NOT NULL, required_quantity INTEGER NOT NULL,
          operational_status TEXT NOT NULL, is_demo INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inbound_shipments (
          shipment_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, order_id TEXT NOT NULL,
          supplier_name TEXT NOT NULL, sku TEXT NOT NULL, originally_expected_quantity INTEGER NOT NULL,
          original_promised_arrival_iso TEXT NOT NULL, status TEXT NOT NULL, is_demo INTEGER NOT NULL
        );
      `);
      db.exec('BEGIN');
      try {
        db.exec('DELETE FROM orders; DELETE FROM inbound_shipments;');
        const insertOrder = db.prepare(
          'INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
        );
        for (const o of seed.orders) {
          insertOrder.run(
            o.orderId,
            o.revisionId,
            o.customerName,
            o.eventName,
            o.deliveryLocation,
            o.deliveryDeadlineIso,
            o.sku,
            o.itemDescription,
            o.requiredQuantity,
            o.operationalStatus
          );
        }
        const insertInbound = db.prepare(
          'INSERT INTO inbound_shipments VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)'
        );
        for (const i of seed.inboundShipments) {
          insertInbound.run(
            i.shipmentId,
            i.revisionId,
            i.orderId,
            i.supplierName,
            i.sku,
            i.originallyExpectedQuantity,
            i.originalPromisedArrivalIso,
            i.status
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    } finally {
      db.close();
    }
    fs.writeFileSync(this.inventoryPath, encodeWarehouseCsv(seed.warehouses), 'utf8');
    fs.writeFileSync(this.supplierPath, JSON.stringify(seed.supplierMessages), 'utf8');
    fs.writeFileSync(this.backupPath, JSON.stringify(seed.backupListings), 'utf8');
  }

  /** Replaces one SKU's warehouse row and leaves every other SKU untouched. */
  async writeWarehouse(w: SyntheticWarehouseRecord): Promise<void> {
    const current = this.readInventoryRecords();
    const next = current.some((row) => row.sku === w.sku)
      ? current.map((row) => (row.sku === w.sku ? w : row))
      : [...current, w];
    fs.writeFileSync(this.inventoryPath, encodeWarehouseCsv(next), 'utf8');
  }

  /** Replaces one order's message and leaves every other order's message untouched. */
  async writeSupplierMessage(m: SyntheticSupplierUpdateRecord): Promise<void> {
    const record: SyntheticSupplierUpdateRecord = {
      messageId: m.messageId,
      revisionId: m.revisionId,
      orderId: m.orderId,
      supplierName: m.supplierName,
      rawMessageText: m.rawMessageText,
      receivedAtIso: m.receivedAtIso,
      isDemo: true
    };
    const current = this.readSupplierRecords();
    const next = current.some((row) => row.orderId === record.orderId)
      ? current.map((row) => (row.orderId === record.orderId ? record : row))
      : [...current, record];
    fs.writeFileSync(this.supplierPath, JSON.stringify(next), 'utf8');
  }

  async readOrders(): Promise<SyntheticOrderRecord[]> {
    return this.sqliteRows('SELECT * FROM orders ORDER BY order_id ASC').map((row) =>
      parseSourceRecord(
        OrderSourceSchema,
        {
          orderId: row.order_id,
          revisionId: row.revision_id,
          customerName: row.customer_name,
          eventName: row.event_name,
          deliveryLocation: row.delivery_location,
          deliveryDeadlineIso: row.delivery_deadline_iso,
          sku: row.sku,
          itemDescription: row.item_description,
          requiredQuantity: row.required_quantity,
          operationalStatus: row.operational_status,
          isDemo: true
        },
        'Local order'
      )
    );
  }

  async readOrder(orderId: string): Promise<SyntheticOrderRecord | undefined> {
    const row = this.sqliteRows('SELECT * FROM orders WHERE order_id = ?', [orderId])[0];
    if (!row) return undefined;
    return parseSourceRecord(
      OrderSourceSchema,
      {
        orderId: row.order_id,
        revisionId: row.revision_id,
        customerName: row.customer_name,
        eventName: row.event_name,
        deliveryLocation: row.delivery_location,
        deliveryDeadlineIso: row.delivery_deadline_iso,
        sku: row.sku,
        itemDescription: row.item_description,
        requiredQuantity: row.required_quantity,
        operationalStatus: row.operational_status,
        isDemo: true
      },
      'Local order'
    );
  }

  async readInbound(
    sku: string,
    orderId?: string
  ): Promise<SyntheticInboundShipmentRecord | undefined> {
    const row = orderId
      ? this.sqliteRows(
          'SELECT * FROM inbound_shipments WHERE sku = ? AND order_id = ? ORDER BY shipment_id ASC',
          [sku, orderId]
        )[0]
      : this.sqliteRows(
          'SELECT * FROM inbound_shipments WHERE sku = ? ORDER BY order_id ASC, shipment_id ASC',
          [sku]
        )[0];
    if (!row) return undefined;
    return parseSourceRecord(
      InboundSourceSchema,
      {
        shipmentId: row.shipment_id,
        revisionId: row.revision_id,
        orderId: row.order_id,
        supplierName: row.supplier_name,
        sku: row.sku,
        originallyExpectedQuantity: row.originally_expected_quantity,
        originalPromisedArrivalIso: row.original_promised_arrival_iso,
        status: row.status,
        isDemo: true
      },
      'Local inbound shipment'
    );
  }

  async readInventory(sku: string): Promise<SyntheticWarehouseRecord | undefined> {
    const record = this.readInventoryRecords().find((row) => row.sku === sku);
    if (!record) return undefined;
    return parseSourceRecord(InventorySourceSchema, record, 'Local inventory');
  }

  async readSupplierMessage(orderId: string): Promise<SyntheticSupplierUpdateRecord | undefined> {
    return this.readSupplierRecords().find((m) => m.orderId === orderId);
  }

  async readBackupListings(sku: string): Promise<SyntheticBackupListingRecord[]> {
    const all = this.readBackupRecords();
    return all
      .filter((b) => b.sku === sku)
      .sort((a, b) => {
        const byArrival =
          Date.parse(a.statedDeliveryArrivalIso) - Date.parse(b.statedDeliveryArrivalIso);
        return Number.isNaN(byArrival) || byArrival === 0
          ? a.listingId.localeCompare(b.listingId)
          : byArrival;
      });
  }

  private readInventoryRecords(): SyntheticWarehouseRecord[] {
    const raw = this.readFile(this.inventoryPath, 'Warehouse CSV');
    return parseWarehouseCsv(raw).map((row) =>
      parseSourceRecord(
        InventorySourceSchema,
        {
          warehouseId: row.warehouse_id,
          revisionId: row.revision_id,
          sku: row.sku,
          physicallyPresent: sourceInteger(row.physically_present, 'Warehouse present count'),
          damaged: sourceInteger(row.damaged, 'Warehouse damaged count'),
          activeAllocations: sourceInteger(row.active_allocations, 'Warehouse allocation count'),
          lastAuditedIso: row.last_audited_iso,
          isDemo: true
        },
        'Local inventory'
      )
    );
  }

  private readSupplierRecords(): SyntheticSupplierUpdateRecord[] {
    return parseSourceRecord(
      z.array(SupplierSourceSchema),
      parseJsonOrThrow(
        this.readFile(this.supplierPath, 'Supplier message store'),
        'Supplier message store',
        'SOURCE_UNAVAILABLE'
      ),
      'Supplier message store'
    );
  }

  private readBackupRecords(): SyntheticBackupListingRecord[] {
    return parseSourceRecord(
      z.array(BackupSourceSchema),
      parseJsonOrThrow(
        this.readFile(this.backupPath, 'Backup listing store'),
        'Backup listing store',
        'SOURCE_UNAVAILABLE'
      ),
      'Backup listing store'
    );
  }

  private sqliteRows(sql: string, params: Array<string | number> = []): Record<string, unknown>[] {
    if (!fs.existsSync(this.sqlitePath)) {
      throw new DomainError(
        `Orders database not found at ${this.sqlitePath}`,
        'SOURCE_UNAVAILABLE'
      );
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.sqlitePath);
      return db.prepare(sql).all(...params) as Record<string, unknown>[];
    } catch {
      throw new DomainError('Orders database could not be read.', 'SOURCE_UNAVAILABLE');
    } finally {
      db?.close();
    }
  }

  private readFile(filePath: string, what: string): string {
    if (!fs.existsSync(filePath)) {
      throw new DomainError(`${what} not found at ${filePath}`, 'SOURCE_UNAVAILABLE');
    }
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      throw new DomainError(`${what} could not be read.`, 'SOURCE_UNAVAILABLE');
    }
  }
}
