import { encodeWarehouseCsv } from './warehouseCsv';
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
        DELETE FROM orders;
        DELETE FROM inbound_shipments;
      `);
      const o = seed.order;
      db.prepare('INSERT INTO orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
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
      if (seed.inboundShipment) {
        const i = seed.inboundShipment;
        db.prepare('INSERT INTO inbound_shipments VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)').run(
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
    } finally {
      db.close();
    }
    await this.writeWarehouse(seed.warehouse);
    await this.writeSupplierMessage(seed.supplierMessage);
    fs.writeFileSync(
      this.backupPath,
      JSON.stringify(seed.backupListing ? [seed.backupListing] : []),
      'utf8'
    );
  }

  async writeWarehouse(w: SyntheticWarehouseRecord): Promise<void> {
    fs.writeFileSync(this.inventoryPath, encodeWarehouseCsv(w), 'utf8');
  }

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
    fs.writeFileSync(this.supplierPath, JSON.stringify([record]), 'utf8');
  }

  async readOrder(orderId: string): Promise<SyntheticOrderRecord | undefined> {
    const row = this.sqliteRow('SELECT * FROM orders WHERE order_id = ?', orderId);
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

  async readInbound(sku: string): Promise<SyntheticInboundShipmentRecord | undefined> {
    const row = this.sqliteRow('SELECT * FROM inbound_shipments WHERE sku = ?', sku);
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
    const lines = this.readFile(this.inventoryPath, 'Warehouse CSV').trim().split('\n').slice(1);
    const cols = lines.map((l) => l.split(',')).find((c) => c[2] === sku);
    if (!cols) return undefined;
    return parseSourceRecord(
      InventorySourceSchema,
      {
        warehouseId: cols[0]!,
        revisionId: cols[1]!,
        sku: cols[2]!,
        physicallyPresent: sourceInteger(cols[3], 'Warehouse present count'),
        damaged: sourceInteger(cols[4], 'Warehouse damaged count'),
        activeAllocations: sourceInteger(cols[5], 'Warehouse allocation count'),
        lastAuditedIso: cols[6]!,
        isDemo: true
      },
      'Local inventory'
    );
  }

  async readSupplierMessage(orderId: string): Promise<SyntheticSupplierUpdateRecord | undefined> {
    const all = parseSourceRecord(
      z.array(SupplierSourceSchema),
      parseJsonOrThrow(
        this.readFile(this.supplierPath, 'Supplier message store'),
        'Supplier message store',
        'SOURCE_UNAVAILABLE'
      ),
      'Supplier message store'
    );
    return all.find((m) => m.orderId === orderId);
  }

  async readBackupListing(sku: string): Promise<SyntheticBackupListingRecord | undefined> {
    const all = parseSourceRecord(
      z.array(BackupSourceSchema),
      parseJsonOrThrow(
        this.readFile(this.backupPath, 'Backup listing store'),
        'Backup listing store',
        'SOURCE_UNAVAILABLE'
      ),
      'Backup listing store'
    );
    return all.find((b) => b.sku === sku);
  }

  private sqliteRow(sql: string, param: string): Record<string, unknown> | undefined {
    if (!fs.existsSync(this.sqlitePath)) {
      throw new DomainError(
        `Orders database not found at ${this.sqlitePath}`,
        'SOURCE_UNAVAILABLE'
      );
    }
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.sqlitePath);
      return db.prepare(sql).get(param) as Record<string, unknown> | undefined;
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
