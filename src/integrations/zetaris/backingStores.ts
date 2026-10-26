import { encodeWarehouseCsv } from '../sources/warehouseCsv';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import type {
  SyntheticBackupListingRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticWarehouseRecord
} from '../../demo/seedData';
import type { SourceSeed, SourceWriter } from '../sources/types';
import { ZetarisClient } from './client';

/**
 * The two backing systems Zetaris federates for Dispatch:
 *  - PostgreSQL (orders, inbound shipments), registered with CREATE DATASOURCE.
 *  - CSV / JSON-lines files (warehouse stock, supplier messages, backup listings), registered as
 *    Lightning FILESTORE tables under the platform's local file root.
 * Dispatch writes to these systems directly (seed, reset, new source revisions) and reads only
 * through Zetaris.
 */

export const ZETARIS_DATASOURCE = 'DISPATCH_ORDERS_PG';
export const ZETARIS_FILES_DB = 'DISPATCH_FILES';

export interface BackingStoreConfig {
  pg: { host: string; port: number; database: string; user: string; password: string };
  /** Host folder mounted into the Zetaris driver. */
  filesDir: string;
  /** The same folder as the Zetaris driver sees it. */
  filesPathInZetaris: string;
  /** JDBC URL as the Zetaris driver reaches PostgreSQL (container network). */
  jdbcUrlFromZetaris: string;
}

export function backingStoreConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): BackingStoreConfig | undefined {
  if (!env.DISPATCH_PG_PASSWORD) return undefined;
  return {
    pg: {
      host: env.DISPATCH_PG_HOST ?? '127.0.0.1',
      port: Number(env.DISPATCH_PG_PORT ?? 55432),
      database: env.DISPATCH_PG_DATABASE ?? 'dispatch_orders',
      user: env.DISPATCH_PG_USER ?? 'dispatch',
      password: env.DISPATCH_PG_PASSWORD
    },
    filesDir:
      env.DISPATCH_ZETARIS_FILES_DIR ?? path.join(process.cwd(), '.local/zetaris/sources/files'),
    filesPathInZetaris:
      env.DISPATCH_ZETARIS_FILES_PATH ?? '/home/zetaris/customer-data/shared/dispatch',
    jdbcUrlFromZetaris:
      env.DISPATCH_ZETARIS_JDBC_URL ?? 'jdbc:postgresql://orders-db:5432/dispatch_orders'
  };
}

const FILES = {
  inventory: 'warehouse_inventory.csv',
  supplierMessages: 'supplier_messages.json',
  backupListings: 'backup_listings.json'
} as const;

export class BackingStores implements SourceWriter {
  constructor(private readonly config: BackingStoreConfig) {}

  /** Replaces every record in both systems with the seed (demo reset). */
  async seed(seed: SourceSeed): Promise<void> {
    await this.withPg(async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS orders (
          order_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, customer_name TEXT NOT NULL,
          event_name TEXT NOT NULL, delivery_location TEXT NOT NULL, delivery_deadline_iso TEXT NOT NULL,
          sku TEXT NOT NULL, item_description TEXT NOT NULL, required_quantity INTEGER NOT NULL,
          operational_status TEXT NOT NULL, is_demo BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS inbound_shipments (
          shipment_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, order_id TEXT NOT NULL,
          supplier_name TEXT NOT NULL, sku TEXT NOT NULL, originally_expected_quantity INTEGER NOT NULL,
          original_promised_arrival_iso TEXT NOT NULL, status TEXT NOT NULL, is_demo BOOLEAN NOT NULL
        );
      `);
      await db.query('BEGIN');
      await db.query('DELETE FROM orders');
      await db.query('DELETE FROM inbound_shipments');
      const o = seed.order;
      await db.query('INSERT INTO orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        o.orderId,
        o.revisionId,
        o.customerName,
        o.eventName,
        o.deliveryLocation,
        o.deliveryDeadlineIso,
        o.sku,
        o.itemDescription,
        o.requiredQuantity,
        o.operationalStatus,
        true
      ]);
      if (seed.inboundShipment) {
        const i = seed.inboundShipment;
        await db.query('INSERT INTO inbound_shipments VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
          i.shipmentId,
          i.revisionId,
          i.orderId,
          i.supplierName,
          i.sku,
          i.originallyExpectedQuantity,
          i.originalPromisedArrivalIso,
          i.status,
          true
        ]);
      }
      await db.query('COMMIT');
    });

    fs.mkdirSync(this.config.filesDir, { recursive: true });
    await this.writeWarehouse(seed.warehouse);
    await this.writeSupplierMessage(seed.supplierMessage);
    this.writeJsonLines(FILES.backupListings, seed.backupListing ? [seed.backupListing] : []);
  }

  /** Seeded when PostgreSQL holds the order table with rows and all three files exist. */
  async isSeeded(): Promise<boolean> {
    const filesExist = Object.values(FILES).every((f) =>
      fs.existsSync(path.join(this.config.filesDir, f))
    );
    if (!filesExist) return false;
    return this.withPg(async (db) => {
      const r = await db.query("SELECT to_regclass('public.orders') IS NOT NULL AS ok");
      if (!r.rows[0]?.ok) return false;
      const c = await db.query('SELECT count(*)::int AS n FROM orders');
      return (c.rows[0]?.n ?? 0) > 0;
    });
  }

  async writeWarehouse(w: SyntheticWarehouseRecord): Promise<void> {
    this.writeAtomically(FILES.inventory, encodeWarehouseCsv(w));
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
    this.writeJsonLines(FILES.supplierMessages, [record]);
  }

  /** Registers both systems in Zetaris, replacing earlier registrations. */
  async registerInZetaris(client: ZetarisClient): Promise<void> {
    const { pg: p, jdbcUrlFromZetaris, filesPathInZetaris } = this.config;
    const existing = await client.query('SHOW DATASOURCES');
    if (existing.rows.some((r) => r.name?.toUpperCase() === ZETARIS_DATASOURCE)) {
      await client.query(`DROP DATASOURCE ${ZETARIS_DATASOURCE}`);
    }
    await client.query(
      `CREATE DATASOURCE ${ZETARIS_DATASOURCE} DESCRIBE BY "Dispatch orders, PostgreSQL" OPTIONS (` +
        `jdbcdriver "org.postgresql.Driver", jdbcurl "${jdbcUrlFromZetaris}", ` +
        `username "${p.user}", password "${p.password}", fetchsize "100")`
    );
    await client.query(`REGISTER DATASOURCE TABLES FROM ${ZETARIS_DATASOURCE}`);

    const dbs = await client.query('SHOW LIGHTNING DATABASES');
    if (dbs.rows.some((r) => r.name?.toUpperCase() === ZETARIS_FILES_DB)) {
      await client.query(`DROP LIGHTNING DATABASE ${ZETARIS_FILES_DB}`);
    }
    await client.query(
      `CREATE LIGHTNING DATABASE ${ZETARIS_FILES_DB} DESCRIBE BY "Dispatch files"`
    );
    const table = (name: string, format: 'CSV' | 'JSON', file: string, extra = '') =>
      client.query(
        `CREATE LIGHTNING FILESTORE TABLE ${name} FROM ${ZETARIS_FILES_DB} FORMAT ${format} ` +
          `OPTIONS (path "${filesPathInZetaris}/${file}"${extra})`
      );
    await table('warehouse_inventory', 'CSV', FILES.inventory, ', header "true"');
    await table('supplier_messages', 'JSON', FILES.supplierMessages);
    await table('backup_listings', 'JSON', FILES.backupListings);
  }

  private writeJsonLines(file: string, records: unknown[]): void {
    this.writeAtomically(
      file,
      records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')
    );
  }

  /** Write-then-rename so Zetaris never reads a half-written file. */
  private writeAtomically(file: string, content: string): void {
    const target = path.join(this.config.filesDir, file);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, target);
  }

  private async withPg<T>(fn: (db: pg.Client) => Promise<T>): Promise<T> {
    const db = new pg.Client(this.config.pg);
    await db.connect();
    try {
      return await fn(db);
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await db.end();
    }
  }
}
