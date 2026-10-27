import crypto from 'node:crypto';
import { DEFAULT_APPROVAL_POLICY, formatNaira } from '../../domain/policy';
import { DomainError } from '../../domain/errors';
import { calculateUsableStock } from '../../domain/stock';
import { backupUnitsRequired } from '../../domain/shortfall';
import type {
  AllowlistedLookupExecution,
  EvidenceSnapshot,
  SourceReader,
  SourceRecordEnvelope,
  SourceSeed,
  SourceType,
  SourceWriter
} from './types';
import {
  DEMO_TRANSPORT_BUFFER_MINUTES,
  type SyntheticBackupListingRecord,
  type SyntheticInboundShipmentRecord,
  type SyntheticOrderRecord,
  type SyntheticSupplierUpdateRecord,
  type SyntheticWarehouseRecord
} from '../../demo/seedData';
import type { ActiveReservationReader, BackupAvailability } from '../../domain/reservation';

type Tool = AllowlistedLookupExecution['tool'];

/** What deterministic code needs to rank backup lots for one order. */
export interface BackupSelectionCriteria {
  deliveryDeadlineIso: string;
  shortfallQuantity: number;
  transportBufferMinutes?: number;
}

/**
 * Deterministic lot choice: a lot that can arrive in time and cover the shortage wins; if none
 * can, the nearest infeasible lot is still cited so the receipt can explain why. Ties are by
 * stated arrival and then listing id, never by array order or randomness.
 */
export function selectBackupListing(
  listings: SyntheticBackupListingRecord[],
  criteria?: BackupSelectionCriteria,
  /** Effective stock after reservations; defaults to the listing's advertised quantity. */
  availableQuantityOf: (listing: SyntheticBackupListingRecord) => number = (listing) =>
    listing.availableQuantity
): SyntheticBackupListingRecord | undefined {
  if (!criteria) return listings[0];
  const cutoff =
    Date.parse(criteria.deliveryDeadlineIso) -
    (criteria.transportBufferMinutes ?? DEMO_TRANSPORT_BUFFER_MINUTES) * 60_000;
  const ranked = listings.map((listing) => {
    const arrival = Date.parse(listing.statedDeliveryArrivalIso);
    return {
      listing,
      arrival: Number.isNaN(arrival) ? Number.POSITIVE_INFINITY : arrival,
      eligible: !Number.isNaN(arrival) && arrival <= cutoff,
      sufficient: availableQuantityOf(listing) >= criteria.shortfallQuantity
    };
  });
  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (a.sufficient !== b.sufficient) return a.sufficient ? -1 : 1;
    if (a.arrival !== b.arrival) return a.arrival - b.arrival;
    return a.listing.listingId.localeCompare(b.listing.listingId);
  });
  return ranked[0]?.listing;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The allowlisted read-only lookups, evidence envelopes and snapshots, independent of where the
 * records live. In Zetaris mode the reader issues Zetaris SQL; in local-files mode it reads files.
 * A source that cannot be read becomes an `error` lookup, never substitute data.
 */
export class SourceGateway {
  constructor(
    private readonly reader: SourceReader,
    private readonly writer: SourceWriter,
    private readonly reservations?: ActiveReservationReader
  ) {}

  get providerMode() {
    return this.reader.providerMode;
  }

  isSeeded(): Promise<boolean> {
    return this.writer.isSeeded();
  }

  async listOrders(signal?: AbortSignal): Promise<SyntheticOrderRecord[]> {
    return this.reader.readOrders(signal);
  }

  async readOrderRecord(
    orderId: string,
    signal?: AbortSignal
  ): Promise<SyntheticOrderRecord | undefined> {
    return this.reader.readOrder(orderId, signal);
  }

  seed(seed: SourceSeed): Promise<void> {
    return this.writer.seed(seed);
  }

  writeWarehouse(record: SyntheticWarehouseRecord): Promise<void> {
    return this.writer.writeWarehouse(record);
  }

  writeSupplierMessage(record: SyntheticSupplierUpdateRecord): Promise<void> {
    return this.writer.writeSupplierMessage(record);
  }

  lookupOrder(orderId: string, ts: string, signal?: AbortSignal) {
    return this.lookup<SyntheticOrderRecord>(
      'get_order',
      { order_id: orderId },
      'orders',
      ts,
      () => this.reader.readOrder(orderId, signal),
      (o) => ({
        recordId: o.orderId,
        summary: `Order ${o.orderId}: ${o.requiredQuantity} x ${o.sku} due ${o.deliveryDeadlineIso}`
      }),
      `Order ${orderId} not found`
    );
  }

  lookupInventory(sku: string, ts: string, signal?: AbortSignal) {
    return this.lookup<SyntheticWarehouseRecord>(
      'get_inventory',
      { sku },
      'inventory',
      ts,
      () => this.reader.readInventory(sku, signal),
      (w) => ({
        recordId: w.warehouseId,
        summary: `Warehouse ${w.warehouseId}: ${w.physicallyPresent} present, ${w.damaged} damaged, ${w.activeAllocations} allocated`
      }),
      `No warehouse stock row for SKU ${sku}`
    );
  }

  lookupInbound(sku: string, ts: string, signal?: AbortSignal, orderId?: string) {
    return this.lookup<SyntheticInboundShipmentRecord>(
      'get_inbound',
      orderId ? { sku, order_id: orderId } : { sku },
      'inbound_shipments',
      ts,
      () => this.reader.readInbound(sku, orderId, signal),
      (i) => ({
        recordId: i.shipmentId,
        summary: `Inbound ${i.shipmentId} (${i.supplierName}): ${i.originallyExpectedQuantity} x ${i.sku}, status=${i.status}`
      }),
      orderId
        ? `No scheduled inbound shipment for order ${orderId}`
        : `No scheduled inbound shipment for SKU ${sku}`
    );
  }

  lookupSupplierMessages(orderId: string, ts: string, signal?: AbortSignal) {
    return this.lookup<SyntheticSupplierUpdateRecord>(
      'get_supplier_messages',
      { order_id: orderId },
      'supplier_updates',
      ts,
      () => this.reader.readSupplierMessage(orderId, signal),
      (m) => ({
        recordId: m.messageId,
        summary: `Message ${m.messageId} (${m.revisionId}) from ${m.supplierName} (${m.rawMessageText.length} chars)`
      }),
      `No supplier update for order ${orderId}`
    );
  }

  async lookupBackupListings(
    sku: string,
    ts: string,
    signal?: AbortSignal,
    criteria?: BackupSelectionCriteria
  ) {
    const availabilityOf = (listing: SyntheticBackupListingRecord) =>
      this.backupAvailability(listing);
    const execution = await this.lookup<SyntheticBackupListingRecord>(
      'get_backup_listings',
      criteria
        ? {
            sku,
            order_deadline: criteria.deliveryDeadlineIso,
            shortage: String(criteria.shortfallQuantity)
          }
        : { sku },
      'backup_listings',
      ts,
      async () =>
        selectBackupListing(
          await this.reader.readBackupListings(sku, signal),
          criteria,
          (listing) => availabilityOf(listing).availableQuantity
        ),
      (b) => ({
        recordId: b.listingId,
        summary: `Candidate listing ${b.listingId} (${b.supplierName}): ${b.availableQuantity} x ${b.sku} at ${formatNaira(b.costKobo)}, stated arrival ${b.statedDeliveryArrivalIso} (unconfirmed candidate)`
      }),
      `No approved backup listing for SKU ${sku}`
    );
    if (!execution.envelope) return execution;
    const availability = availabilityOf(execution.envelope.data);
    return {
      ...execution,
      availability,
      outcomeSummary: `${execution.outcomeSummary} — ${availability.availableQuantity} available, ${availability.reservedQuantity} reserved by active plans`
    };
  }

  /** Advertised stock minus every active reservation for this lot. */
  backupAvailability(listing: SyntheticBackupListingRecord): BackupAvailability {
    const reservations = this.reservations?.listActiveReservations(listing.listingId) ?? [];
    const reservedQuantity = reservations.reduce((sum, r) => sum + r.quantity, 0);
    return {
      listingId: listing.listingId,
      advertisedQuantity: listing.availableQuantity,
      reservedQuantity,
      availableQuantity: Math.max(0, listing.availableQuantity - reservedQuantity),
      reservations
    };
  }

  /** The spend policy is application configuration, not a business source. */
  async lookupPolicy(kind: string): Promise<AllowlistedLookupExecution> {
    const policy = DEFAULT_APPROVAL_POLICY;
    return {
      tool: 'get_policy',
      args: { kind },
      sourceId: 'app:policy-config',
      revisionId: policy.policyId,
      recordId: policy.policyId,
      snapshotHash: sha256(policy),
      status: 'ok',
      outcomeSummary: `Policy ${policy.policyId}: spend above ${formatNaira(policy.thresholdKobo)} requires manager approval`,
      policy
    };
  }

  /** Reads every record the investigation cites. Required sources must be readable. */
  async fetchEvidenceSnapshot(orderId: string, capturedAtIso: string): Promise<EvidenceSnapshot> {
    const order = await this.lookupOrder(orderId, capturedAtIso);
    const sku = order.envelope?.data.sku ?? 'UNKNOWN';
    const orderRecord = order.envelope?.data;
    const inventory = await this.lookupInventory(sku, capturedAtIso);
    const usable = inventory.envelope?.data
      ? calculateUsableStock(inventory.envelope.data).usableAvailable
      : 0;
    const [inbound, supplier, backup] = await Promise.all([
      this.lookupInbound(sku, capturedAtIso, undefined, orderId),
      this.lookupSupplierMessages(orderId, capturedAtIso),
      this.lookupBackupListings(
        sku,
        capturedAtIso,
        undefined,
        orderRecord
          ? {
              deliveryDeadlineIso: orderRecord.deliveryDeadlineIso,
              shortfallQuantity: backupUnitsRequired(orderRecord.requiredQuantity, usable)
            }
          : undefined
      )
    ]);
    return this.snapshotFromLookups(orderId, capturedAtIso, {
      order,
      inventory,
      inbound,
      supplier,
      backup
    });
  }

  /**
   * Assembles a snapshot from lookups that already ran, so an investigation cites exactly
   * the records its lookups read, without reading them a second time.
   */
  snapshotFromLookups(
    orderId: string,
    capturedAtIso: string,
    lookups: {
      order: AllowlistedLookupExecution<SyntheticOrderRecord>;
      inventory: AllowlistedLookupExecution<SyntheticWarehouseRecord>;
      /** Optional: a plan without these lookups cites no inbound shipment or backup listing. */
      inbound?: AllowlistedLookupExecution<SyntheticInboundShipmentRecord>;
      supplier: AllowlistedLookupExecution<SyntheticSupplierUpdateRecord>;
      backup?: AllowlistedLookupExecution<SyntheticBackupListingRecord>;
    }
  ): EvidenceSnapshot {
    const required = <T>(l: AllowlistedLookupExecution<T>) => {
      if (l.status !== 'ok' || !l.envelope)
        throw new DomainError(l.outcomeSummary, 'SOURCE_UNAVAILABLE');
      return l.envelope;
    };
    const sources = {
      orders: required(lookups.order),
      inventory: required(lookups.inventory),
      inboundShipments: lookups.inbound?.envelope,
      supplierUpdates: required(lookups.supplier),
      backupListing: lookups.backup?.envelope,
      backupAvailability: lookups.backup?.availability
    };
    const systems = [
      ...new Set(
        [
          sources.orders,
          sources.inventory,
          sources.inboundShipments,
          sources.supplierUpdates,
          sources.backupListing
        ].flatMap((e) => (e ? [e.backingSystem] : []))
      )
    ];
    return {
      snapshotId: `SNP-${orderId}-${Date.now()}`,
      capturedAtIso,
      providerMode: this.reader.providerMode,
      sources,
      topology: {
        distinctBackingSystemsCount: systems.length,
        backingSystems: systems,
        isMultiSourceCompliant: systems.length >= 2
      }
    };
  }

  private async lookup<T extends { revisionId: string }>(
    tool: Tool,
    args: Record<string, string>,
    sourceType: SourceType,
    timestampIso: string,
    read: () => Promise<T | undefined>,
    describe: (record: T) => { recordId: string; summary: string },
    missingMessage: string
  ): Promise<AllowlistedLookupExecution<T>> {
    const { sourceId, backingSystem } = this.reader.locations[sourceType];
    const fallbackId = Object.values(args)[0] ?? 'unknown';
    let record: T | undefined;
    try {
      record = await read();
    } catch (err) {
      if (!(err instanceof DomainError) || err.code !== 'SOURCE_UNAVAILABLE') throw err;
      return {
        tool,
        args,
        sourceId,
        revisionId: 'NONE',
        recordId: fallbackId,
        snapshotHash: '',
        status: 'error',
        outcomeSummary: err.message
      };
    }
    if (!record) {
      return {
        tool,
        args,
        sourceId,
        revisionId: 'NONE',
        recordId: fallbackId,
        snapshotHash: '',
        status: 'missing',
        outcomeSummary: missingMessage
      };
    }
    const { recordId, summary } = describe(record);
    const { revisionId } = record;
    const envelope: SourceRecordEnvelope<T> = {
      sourceId,
      sourceType,
      backingSystem,
      recordId,
      revisionId,
      timestampIso,
      snapshotHash: sha256(record),
      data: record
    };
    return {
      tool,
      args,
      sourceId,
      revisionId,
      recordId,
      snapshotHash: envelope.snapshotHash,
      status: 'ok',
      outcomeSummary: summary,
      envelope
    };
  }
}
