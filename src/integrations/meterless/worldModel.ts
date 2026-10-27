import fs from 'node:fs';
import path from 'node:path';
import {
  WorldModel,
  canonicalJson,
  entityIdFromName,
  externalId,
  type Entity,
  type IngestObservation,
  type MergeProposal,
  type Provenance,
  type WorldEvent
} from '@meterless/world-model-reference';
import type { EvidenceSnapshot, SourceRecordEnvelope, SourceType } from '../sources/types';
import type {
  SyntheticBackupListingRecord,
  SyntheticInboundShipmentRecord,
  SyntheticOrderRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticWarehouseRecord
} from '../../demo/seedData';
import type { BackupReservationRecord } from '../../domain/reservation';
import type {
  ResolvedSupplier,
  WorldEntity,
  WorldMatch,
  WorldModelContext,
  WorldModelReference,
  WorldModelState,
  WorldSourceRecord
} from '../../domain/worldModel';
import { calculateUsableStock } from '../../domain/stock';
import { DomainError } from '../../domain/errors';

export const WORLD_MODEL_NAMESPACE = 'dispatch';
export const WORLD_MODEL_IMPLEMENTATION =
  'Meterless World Model (reference implementation)' as const;

type AnyEnvelope =
  | SourceRecordEnvelope<SyntheticOrderRecord>
  | SourceRecordEnvelope<SyntheticWarehouseRecord>
  | SourceRecordEnvelope<SyntheticInboundShipmentRecord>
  | SourceRecordEnvelope<SyntheticSupplierUpdateRecord>
  | SourceRecordEnvelope<SyntheticBackupListingRecord>;

export interface WorldModelServiceOptions {
  /** The app data directory. Local storage writes `.world/<namespace>.json` under it. */
  dataDir: string;
  namespace?: string;
  storage?: 'local' | 'memory';
  /** Used only for genuinely-now operator actions (merge review), never for record timestamps. */
  clock?: () => Date;
}

export interface WorldIngestResult {
  runId: string;
  processed: number;
  skippedUnchanged: number;
  changed: boolean;
  eventId: string;
  eventSeq: number;
  /** The exact reference a receipt saved after this ingest cites. */
  reference: WorldModelReference;
  context: WorldModelContext | null;
}

interface Head {
  id: string;
  seq: number;
}

interface SupplierGroup {
  canonical: Entity;
  members: Map<string, Entity>;
  records: Map<string, WorldSourceRecord>;
}

/**
 * Adapter around Meterless's reference World Model.
 *
 * Dispatch reads every source. This class only mirrors the records it is handed, so World Model
 * never fetches, decides stock, locks a reservation or sends anything. Record timestamps come from
 * the source revision id; replaying the same lookups is a no-op. The event id returned here is the
 * one a receipt cites.
 */
export class WorldModelService {
  public readonly namespace: string;
  public readonly storage: 'local' | 'memory';
  private readonly dataDir: string;
  private readonly clock: () => Date;
  private world: WorldModel;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(options: WorldModelServiceOptions) {
    this.namespace = options.namespace ?? WORLD_MODEL_NAMESPACE;
    this.storage = options.storage ?? 'local';
    this.dataDir = options.dataDir;
    this.clock = options.clock ?? (() => new Date());
    this.world = this.open();
  }

  /** Absolute path of the namespace file; meaningful only for local storage. */
  get filePath(): string {
    return path.join(this.dataDir, '.world', `${this.namespace}.json`);
  }

  isEmpty(): boolean {
    return this.world.events().length === 0;
  }

  eventCount(): number {
    return this.world.events().length;
  }

  /** Deletes the namespace file and starts an empty in-memory instance. */
  reset(): Promise<void> {
    return this.serialize(async () => {
      if (this.storage === 'local') fs.rmSync(this.filePath, { force: true });
      this.world = this.open();
    });
  }

  async ingestSnapshot(
    snapshot: EvidenceSnapshot,
    reservations: BackupReservationRecord[] = []
  ): Promise<WorldIngestResult> {
    return this.serialize(() => this.ingestNow(snapshot, reservations));
  }

  private async ingestNow(
    snapshot: EvidenceSnapshot,
    reservations: BackupReservationRecord[]
  ): Promise<WorldIngestResult> {
    const observations = this.observationsFor(snapshot, reservations);
    const before = this.head().seq;
    const report = await this.world.ingest(observations);

    // Mirroring is idempotent: every write is skipped when the same value is already present.
    // Running it even when the observation batch was a replay recovers a previous partial run.
    await this.mirrorSnapshot(snapshot);
    await this.mirrorReservations(reservations);

    const head = this.head();
    const orderId = snapshot.sources.orders.data.orderId;
    // `sources` also carries live availability, which is not an envelope. List the envelopes
    // explicitly so a new key can never be mistaken for a cited record.
    const envelopes: Array<SourceRecordEnvelope<unknown> | undefined> = [
      snapshot.sources.orders,
      snapshot.sources.inventory,
      snapshot.sources.inboundShipments,
      snapshot.sources.supplierUpdates,
      snapshot.sources.backupListing
    ];
    const records = envelopes.filter(
      (envelope): envelope is SourceRecordEnvelope<unknown> => envelope !== undefined
    );
    const resolvedSuppliers = this.resolvedSuppliers(orderId)
      .map((supplier) => ({
        ...supplier,
        sourceRecords: supplier.sourceRecords.filter((record) =>
          records.some(
            (envelope) =>
              envelope.sourceType === record.sourceType &&
              envelope.recordId === record.recordId &&
              envelope.revisionId === record.revisionId
          )
        )
      }))
      .filter((supplier) => supplier.sourceRecords.length > 0);
    return {
      runId: report.runId,
      processed: report.processed,
      skippedUnchanged: report.skippedUnchanged,
      changed: head.seq > before,
      eventId: head.id,
      eventSeq: head.seq,
      context: this.contextForOrder(orderId),
      reference: {
        namespace: this.namespace,
        runId: report.runId,
        eventId: head.id,
        eventSeq: head.seq,
        contextEntityId: externalId('order', 'dispatch', orderId),
        resolvedSuppliers
      }
    };
  }

  /** The order entity plus its neighbours, resolved through approved aliases. */
  contextForOrder(orderId: string): WorldModelContext | null {
    const graph = this.world.view('graph');
    const orderEntityId = externalId('order', 'dispatch', orderId);
    const order = graph.entity(orderEntityId);
    if (!order) return null;

    const neighbours = new Map<string, WorldModelContext['neighbours'][number]>();
    const add = (via: string, hop: number, entity: Entity) => {
      const view = this.entityView(entity);
      neighbours.set(`${via}:${view.id}`, { via, hop, entity: view });
    };

    for (const sku of graph.neighborsOf(order.id, { via: 'requires' })) {
      add('requires', 1, sku);
      for (const supplier of graph.neighborsOf(sku.id, { via: 'supplies' }))
        add('supplies', 2, supplier);
      for (const lot of graph.neighborsOf(sku.id, { via: 'offers' })) add('offers', 2, lot);
      for (const warehouse of graph.neighborsOf(sku.id, { via: 'stocks' }))
        add('stocks', 2, warehouse);
    }
    // The reference retains historical edges. Current holds come from mirrored SQL statuses.
    const holds = graph.query({
      type: 'reservation',
      where: (entity) => entity.attrs.status === 'active'
    });
    for (const hold of holds.filter((entity) => entity.attrs.orderId === orderId)) {
      const lotId = externalId('backup_lot', 'dispatch', String(hold.attrs.listingId));
      const lot = graph.entity(lotId);
      if (!lot) continue;
      add('reserves', 1, lot);
      for (const other of holds.filter(
        (entity) => entity.attrs.listingId === hold.attrs.listingId
      )) {
        const holder = graph.entity(externalId('order', 'dispatch', String(other.attrs.orderId)));
        if (holder && holder.id !== order.id) add('reserves', 2, holder);
      }
    }

    const head = this.head();
    return {
      order: this.entityView(order),
      neighbours: [...neighbours.values()].sort(
        (a, b) =>
          a.hop - b.hop ||
          a.via.localeCompare(b.via) ||
          a.entity.type.localeCompare(b.entity.type) ||
          (a.entity.name ?? a.entity.id).localeCompare(b.entity.name ?? b.entity.id)
      ),
      suppliers: this.resolvedSuppliers(orderId),
      eventId: head.id,
      eventSeq: head.seq
    };
  }

  /** The review queue plus identities already merged or rejected. */
  matches(): WorldMatch[] {
    return this.supplierProposals()
      .map((proposal: MergeProposal) => ({
        proposalId: proposal.id,
        leftName: proposal.leftName,
        rightName: proposal.rightName,
        similarity: proposal.similarity,
        status: proposal.status,
        proposedAt: proposal.proposedAt,
        resolvedAt: proposal.resolvedAt,
        resolvedBy: proposal.resolvedBy
      }))
      .sort(
        (a, b) =>
          a.proposedAt.localeCompare(b.proposedAt) || a.proposalId.localeCompare(b.proposalId)
      );
  }

  private supplierProposals(): readonly MergeProposal[] {
    const graph = this.world.view('graph');
    return this.world
      .mergeQueue()
      .filter(
        (proposal) =>
          graph.entity(proposal.leftId)?.type === 'supplier' &&
          graph.entity(proposal.rightId)?.type === 'supplier'
      );
  }

  async resolveMatch(
    proposalId: string,
    decision: 'approve' | 'reject',
    actorName: string
  ): Promise<WorldMatch> {
    return this.serialize(() => this.resolveNow(proposalId, decision, actorName));
  }

  private async resolveNow(
    proposalId: string,
    decision: 'approve' | 'reject',
    actorName: string
  ): Promise<WorldMatch> {
    const proposal = this.supplierProposals().find((candidate) => candidate.id === proposalId);
    if (proposal && proposal.status !== 'pending') {
      const status = decision === 'approve' ? 'approved' : 'rejected';
      if (proposal.status === status && proposal.resolvedBy === actorName) {
        return this.matches().find((candidate) => candidate.proposalId === proposalId)!;
      }
    }
    if (!proposal || proposal.status !== 'pending') {
      throw new DomainError(`No pending match ${proposalId}.`, 'MATCH_NOT_FOUND');
    }

    const at = this.clock().toISOString();
    if (decision === 'approve') await this.world.approveMerge(proposalId, actorName);
    else await this.world.rejectMerge(proposalId, actorName);

    // The reference appends the alias before it records the proposal's resolved status. A
    // provenance-carrying decision fact forces the updated queue to disk and leaves an audit trail.
    await this.world.assertFact({
      about: proposal.rightId,
      predicate: `merge_decision_${proposal.id}`,
      value: { decision, by: actorName, at },
      confidence: 1,
      source: { kind: 'manual', by: actorName, at }
    });

    const resolved = this.matches().find((candidate) => candidate.proposalId === proposalId);
    if (!resolved) throw new DomainError(`Match ${proposalId} disappeared.`, 'MATCH_NOT_FOUND');
    return resolved;
  }

  /** UI state for one order. Context is null only when the order has not been mirrored yet. */
  uiState(orderId: string): WorldModelState {
    const matches = this.matches();
    const head = this.head();
    return {
      implementation: WORLD_MODEL_IMPLEMENTATION,
      storage: this.storage,
      namespace: this.namespace,
      eventCount: this.world.events().length,
      entityCount: this.world.view('graph').query({}).length,
      headEventId: head.id,
      headEventSeq: head.seq,
      pendingMatches: matches.filter((match) => match.status === 'pending'),
      recentMatches: matches
        .filter((match) => match.status !== 'pending')
        .slice(-5)
        .reverse(),
      context: this.contextForOrder(orderId)
    };
  }

  // ------------------------------------------------------------------ mirror

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private open(): WorldModel {
    return new WorldModel({
      namespace: this.namespace,
      storage: this.storage,
      directory: this.dataDir,
      clock: this.clock,
      // The reference's own bands are the spec; do not tune them for the demo.
      resolver: { autoMergeAt: 0.85, reviewBand: [0.82, 0.85] },
      conflictPolicy: 'most-recent-wins'
    });
  }

  private observationsFor(
    snapshot: EvidenceSnapshot,
    reservations: BackupReservationRecord[]
  ): IngestObservation[] {
    const observations: IngestObservation[] = [];
    const add = (envelope: AnyEnvelope, text: unknown) => {
      const at = revisionAtIso(envelope);
      observations.push({
        externalId: `${envelope.sourceType}:${envelope.recordId}:${envelope.revisionId}`,
        type: 'source_record',
        title: `${envelope.sourceType}:${envelope.recordId} @ ${envelope.revisionId}`,
        text: canonicalJson(text),
        at,
        source: provenanceFor(envelope, at)
      });
    };
    add(snapshot.sources.orders, snapshot.sources.orders.data);
    add(snapshot.sources.inventory, snapshot.sources.inventory.data);
    if (snapshot.sources.inboundShipments)
      add(snapshot.sources.inboundShipments, snapshot.sources.inboundShipments.data);
    add(snapshot.sources.supplierUpdates, snapshot.sources.supplierUpdates.data);
    if (snapshot.sources.backupListing)
      add(snapshot.sources.backupListing, snapshot.sources.backupListing.data);

    for (const reservation of reservations) {
      const at = reservation.releasedAtIso ?? reservation.createdAtIso;
      observations.push({
        externalId: `reservations:${reservation.reservationId}:v${reservation.receiptVersion}:${reservation.status}`,
        type: 'reservation',
        title: `reservation:${reservation.reservationId}`,
        text: canonicalJson(reservation),
        at,
        source: reservationProvenance(reservation, at)
      });
    }
    return observations;
  }

  private async mirrorSnapshot(snapshot: EvidenceSnapshot): Promise<void> {
    const orderEnvelope = snapshot.sources.orders;
    const inventoryEnvelope = snapshot.sources.inventory;
    const inboundEnvelope = snapshot.sources.inboundShipments;
    const supplierEnvelope = snapshot.sources.supplierUpdates;
    const backupEnvelope = snapshot.sources.backupListing;

    const order = orderEnvelope.data;
    const inventory = inventoryEnvelope.data;
    const orderSource = provenanceFor(orderEnvelope, revisionAtIso(orderEnvelope));
    const inventorySource = provenanceFor(inventoryEnvelope, revisionAtIso(inventoryEnvelope));

    const orderEntityId = await this.ensureExternalEntity(
      'order',
      'dispatch',
      order.orderId,
      {
        orderId: order.orderId,
        eventName: order.eventName,
        customerName: order.customerName,
        deliveryLocation: order.deliveryLocation,
        operationalStatus: order.operationalStatus
      },
      order.eventName,
      orderSource
    );
    const skuEntityId = await this.ensureExternalEntity(
      'sku',
      'catalog',
      order.sku,
      { sku: order.sku, itemDescription: order.itemDescription },
      order.itemDescription,
      orderSource
    );

    await this.fact(orderEntityId, 'required_quantity', order.requiredQuantity, orderSource);
    await this.fact(orderEntityId, 'delivery_deadline_iso', order.deliveryDeadlineIso, orderSource);
    await this.fact(orderEntityId, 'delivery_location', order.deliveryLocation, orderSource);
    await this.fact(orderEntityId, 'operational_status', order.operationalStatus, orderSource);
    await this.fact(orderEntityId, 'sku', order.sku, orderSource);
    await this.fact(skuEntityId, 'item_description', order.itemDescription, orderSource);
    await this.relate(orderEntityId, 'requires', skuEntityId, orderSource, 'order');

    const stock = calculateUsableStock(inventory);
    const warehouseEntityId = await this.ensureExternalEntity(
      'warehouse',
      'dispatch',
      inventory.warehouseId,
      { warehouseId: inventory.warehouseId },
      inventory.warehouseId,
      inventorySource
    );
    await this.fact(
      warehouseEntityId,
      `stock:${inventory.sku}:physically_present`,
      stock.physicallyPresent,
      inventorySource
    );
    await this.fact(
      warehouseEntityId,
      `stock:${inventory.sku}:damaged`,
      stock.damaged,
      inventorySource
    );
    await this.fact(
      warehouseEntityId,
      `stock:${inventory.sku}:active_allocations`,
      stock.activeAllocations,
      inventorySource
    );
    await this.fact(
      warehouseEntityId,
      `stock:${inventory.sku}:usable_available`,
      stock.usableAvailable,
      inventorySource
    );
    await this.fact(
      warehouseEntityId,
      `stock:${inventory.sku}:last_audited_iso`,
      inventory.lastAuditedIso,
      inventorySource
    );
    await this.relate(
      warehouseEntityId,
      'stocks',
      skuEntityId,
      inventorySource,
      `inventory:${inventory.sku}`
    );

    if (inboundEnvelope) {
      const inbound = inboundEnvelope.data;
      const inboundSource = provenanceFor(inboundEnvelope, revisionAtIso(inboundEnvelope));
      const supplierId = await this.ensureSupplier(inbound.supplierName, inboundSource);
      await this.fact(orderEntityId, 'inbound_shipment_id', inbound.shipmentId, inboundSource);
      await this.fact(
        orderEntityId,
        'inbound_expected_arrival_iso',
        inbound.originalPromisedArrivalIso,
        inboundSource
      );
      await this.fact(orderEntityId, 'inbound_status', inbound.status, inboundSource);
      await this.fact(orderEntityId, 'inbound_supplier_name', inbound.supplierName, inboundSource);
      await this.relate(supplierId, 'supplies', skuEntityId, inboundSource, `supply:${order.sku}`);
      await this.recordSupplierSource({
        supplierId,
        orderId: order.orderId,
        sku: order.sku,
        sourceType: 'inbound_shipments',
        recordId: inbound.shipmentId,
        name: inbound.supplierName,
        revisionId: inboundEnvelope.revisionId,
        source: inboundSource
      });
    }

    const supplierSource = provenanceFor(supplierEnvelope, revisionAtIso(supplierEnvelope));
    const supplierId = await this.ensureSupplier(
      supplierEnvelope.data.supplierName,
      supplierSource
    );
    await this.fact(
      orderEntityId,
      'supplier_message_id',
      supplierEnvelope.data.messageId,
      supplierSource
    );
    await this.fact(
      orderEntityId,
      'supplier_message_sender',
      supplierEnvelope.data.supplierName,
      supplierSource
    );
    await this.fact(
      orderEntityId,
      'supplier_message_received_at_iso',
      supplierEnvelope.data.receivedAtIso,
      supplierSource
    );
    await this.relate(supplierId, 'supplies', skuEntityId, supplierSource, `supply:${order.sku}`);
    await this.recordSupplierSource({
      supplierId,
      orderId: order.orderId,
      sku: order.sku,
      sourceType: 'supplier_updates',
      recordId: supplierEnvelope.data.messageId,
      name: supplierEnvelope.data.supplierName,
      revisionId: supplierEnvelope.revisionId,
      source: supplierSource
    });

    if (backupEnvelope) {
      const backup = backupEnvelope.data;
      const backupSource = provenanceFor(backupEnvelope, revisionAtIso(backupEnvelope));
      const backupEntityId = await this.ensureExternalEntity(
        'backup_lot',
        'dispatch',
        backup.listingId,
        { listingId: backup.listingId, sku: backup.sku, supplierName: backup.supplierName },
        backup.listingId,
        backupSource
      );
      const backupSupplierId = await this.ensureSupplier(backup.supplierName, backupSource);
      await this.fact(backupEntityId, 'available_quantity', backup.availableQuantity, backupSource);
      await this.fact(
        backupEntityId,
        'stated_delivery_arrival_iso',
        backup.statedDeliveryArrivalIso,
        backupSource
      );
      await this.fact(backupEntityId, 'cost_kobo', backup.costKobo, backupSource);
      await this.fact(
        backupEntityId,
        'is_confirmed_reservation',
        backup.isConfirmedReservation,
        backupSource
      );
      await this.fact(backupEntityId, 'listing_revision_id', backup.revisionId, backupSource);
      await this.relate(backupEntityId, 'offers', skuEntityId, backupSource, 'offer');
      await this.relate(
        backupSupplierId,
        'supplies',
        skuEntityId,
        backupSource,
        `supply:${order.sku}`
      );
      await this.recordSupplierSource({
        supplierId: backupSupplierId,
        orderId: order.orderId,
        sku: order.sku,
        sourceType: 'backup_listings',
        recordId: backup.listingId,
        name: backup.supplierName,
        revisionId: backupEnvelope.revisionId,
        source: backupSource
      });
    }
  }

  private async mirrorReservations(reservations: BackupReservationRecord[]): Promise<void> {
    for (const reservation of reservations) {
      const at = reservation.releasedAtIso ?? reservation.createdAtIso;
      const source = reservationProvenance(reservation, at);
      const orderEntityId = await this.ensureExternalEntity(
        'order',
        'dispatch',
        reservation.orderId,
        { orderId: reservation.orderId },
        undefined,
        source
      );
      const lotEntityId = await this.ensureExternalEntity(
        'backup_lot',
        'dispatch',
        reservation.backupListingId,
        { listingId: reservation.backupListingId, sku: reservation.sku },
        undefined,
        source
      );
      await this.ensureExternalEntity(
        'reservation',
        'dispatch',
        reservation.reservationId,
        {
          orderId: reservation.orderId,
          listingId: reservation.backupListingId,
          quantity: reservation.quantity,
          status: reservation.status,
          receiptVersion: reservation.receiptVersion
        },
        reservation.reservationId,
        source
      );
      if (reservation.status === 'active') {
        await this.relate(
          orderEntityId,
          'reserves',
          lotEntityId,
          source,
          reservation.reservationId
        );
      }
    }
  }

  // ------------------------------------------------------------------ helpers

  private async ensureExternalEntity(
    type: string,
    system: string,
    id: string,
    attrs: Record<string, unknown>,
    name: string | undefined,
    source: Provenance
  ): Promise<string> {
    const entityId = externalId(type, system, id);
    const existing = this.world.view('graph').entity(entityId);
    const attrsMatch =
      existing !== undefined &&
      Object.entries(attrs).every(
        ([key, value]) => canonicalJson(existing.attrs[key]) === canonicalJson(value)
      );
    const nameMatch = name === undefined || existing?.name === name;
    if (existing && attrsMatch && nameMatch) return existing.id;

    await this.world.upsertEntity({
      type,
      externalKey: { system, id },
      attrs,
      name: name ?? existing?.name,
      source
    });
    return this.world.view('graph').entity(entityId)?.id ?? entityId;
  }

  /**
   * Supplier identities are name-keyed so the reference resolver can auto-merge or queue variants.
   * Once an existing id is present we leave it alone; a fresh variant is the only thing that can
   * create a new proposal.
   */
  private async ensureSupplier(name: string, source: Provenance): Promise<string> {
    const id = entityIdFromName('supplier', name);
    const existing = this.world.view('graph').entity(id);
    if (!existing) {
      await this.world.upsertEntity({ type: 'supplier', name, attrs: { name }, source });
    }
    return this.world.view('graph').entity(id)?.id ?? id;
  }

  private async recordSupplierSource(params: {
    supplierId: string;
    orderId: string;
    sku: string;
    sourceType: SourceType;
    recordId: string;
    name: string;
    revisionId: string;
    source: Provenance;
  }): Promise<void> {
    const recordKey = `${params.orderId}:${params.sourceType}:${params.recordId}:${params.revisionId}`;
    const recordId = await this.ensureExternalEntity(
      'supplier_record',
      'dispatch',
      recordKey,
      {
        sourceType: params.sourceType,
        recordId: params.recordId,
        name: params.name,
        revisionId: params.revisionId,
        backingSystem: params.source.kind,
        supplierEntityId: params.supplierId,
        orderId: params.orderId,
        sku: params.sku
      },
      `${params.sourceType}:${params.recordId}`,
      params.source
    );
    await this.relate(recordId, 'names', params.supplierId, params.source, 'identity');
  }

  private fact(
    about: string,
    predicate: string,
    value: unknown,
    source: Provenance,
    confidence = 1
  ): Promise<unknown> {
    return this.world.assertFact({ about, predicate, value, confidence, source });
  }

  private relate(
    from: string,
    type: string,
    to: string,
    source: Provenance,
    context: string
  ): Promise<unknown> {
    return this.world.relate({ from, type, to, context, source });
  }

  private resolvedSuppliers(orderId: string): ResolvedSupplier[] {
    const graph = this.world.view('graph');
    const groups = new Map<string, SupplierGroup>();
    for (const raw of graph.query({ type: 'supplier' })) {
      const canonical = graph.entity(raw.id) ?? raw;
      const group =
        groups.get(canonical.id) ??
        ({
          canonical,
          members: new Map<string, Entity>(),
          records: new Map<string, WorldSourceRecord>()
        } satisfies SupplierGroup);
      group.members.set(raw.id, raw);
      groups.set(canonical.id, group);
    }

    for (const raw of graph.query({ type: 'supplier_record' })) {
      if (raw.attrs.orderId !== orderId) continue;
      const supplierEntityId =
        typeof raw.attrs.supplierEntityId === 'string' ? raw.attrs.supplierEntityId : undefined;
      if (!supplierEntityId) continue;
      const canonical = graph.entity(supplierEntityId);
      if (!canonical) continue;
      const group =
        groups.get(canonical.id) ??
        ({
          canonical,
          members: new Map<string, Entity>(),
          records: new Map<string, WorldSourceRecord>()
        } satisfies SupplierGroup);
      groups.set(canonical.id, group);

      const sourceType = stringAttr(raw, 'sourceType');
      const recordId = stringAttr(raw, 'recordId');
      const name = stringAttr(raw, 'name');
      const revisionId = stringAttr(raw, 'revisionId');
      const backingSystem = stringAttr(raw, 'backingSystem');
      if (!sourceType || !recordId || !name || !revisionId || !backingSystem) continue;
      group.records.set(`${sourceType}:${recordId}`, {
        sourceType,
        recordId,
        name,
        revisionId,
        backingSystem
      });
    }

    const pending = this.world.mergeQueue().filter((proposal) => proposal.status === 'pending');

    return [...groups.values()]
      .filter((group) => group.records.size > 0)
      .map((group) => {
        const memberIds = new Set(group.members.keys());
        const proposal = pending.find(
          (candidate) => memberIds.has(candidate.leftId) || memberIds.has(candidate.rightId)
        );
        const names = [
          ...new Set(
            [
              group.canonical.name,
              ...group.canonical.aliases,
              ...[...group.members.values()].flatMap((member) => [member.name, ...member.aliases]),
              ...[...group.records.values()].map((record) => record.name)
            ].filter((name): name is string => Boolean(name))
          )
        ].sort((a, b) => a.localeCompare(b));
        const merged =
          group.members.size > 1 ||
          group.canonical.aliases.length > 1 ||
          [...group.members.keys()].some((id) => id !== group.canonical.id);
        return {
          canonicalId: group.canonical.id,
          canonicalName: group.canonical.name ?? names[0] ?? group.canonical.id,
          names,
          status: proposal ? 'pending_review' : merged ? 'merged' : 'single',
          pendingProposalId: proposal?.id,
          sourceRecords: [...group.records.values()].sort(
            (a, b) =>
              a.sourceType.localeCompare(b.sourceType) || a.recordId.localeCompare(b.recordId)
          )
        } satisfies ResolvedSupplier;
      })
      .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
  }

  private entityView(entity: Entity): WorldEntity {
    const canonical = this.world.view('graph').entity(entity.id) ?? entity;
    return {
      id: canonical.id,
      type: canonical.type,
      name: canonical.name ?? null,
      aliases: canonical.aliases
    };
  }

  private head(): Head {
    const events = this.world.events();
    const last: WorldEvent | undefined = events[events.length - 1];
    return last ? { id: last.id, seq: last.seq } : { id: 'evt_0', seq: 0 };
  }
}

function stringAttr(entity: Entity, key: string): string | undefined {
  const value = entity.attrs[key];
  return typeof value === 'string' ? value : undefined;
}

/** Never use the fetch clock as a source revision timestamp. */
function revisionAtIso(envelope: AnyEnvelope): string {
  const match = /-(\d{4})(\d{2})(\d{2})-/.exec(envelope.revisionId);
  const revisionDate = match ? `${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z` : undefined;
  const data = envelope.data;
  const at =
    revisionDate ??
    ('receivedAtIso' in data
      ? data.receivedAtIso
      : 'lastAuditedIso' in data
        ? data.lastAuditedIso
        : 'listedAtIso' in data
          ? data.listedAtIso
          : undefined);
  if (!at || !Number.isFinite(Date.parse(at))) {
    throw new DomainError(
      `Source revision ${envelope.revisionId} has no valid timestamp.`,
      'SOURCE_UNAVAILABLE'
    );
  }
  return at;
}

function provenanceFor(envelope: AnyEnvelope, at: string): Provenance {
  return {
    kind: envelope.backingSystem,
    by: 'dispatch.world-model',
    at,
    url: `${envelope.sourceType}:${envelope.recordId}:${envelope.revisionId}`,
    checksum: envelope.snapshotHash,
    runId: envelope.revisionId
  };
}

function reservationProvenance(reservation: BackupReservationRecord, at: string): Provenance {
  return {
    kind: 'pipeline',
    by: 'dispatch.approval',
    at,
    url: `reservations:${reservation.reservationId}`,
    runId: reservation.receiptId
  };
}
