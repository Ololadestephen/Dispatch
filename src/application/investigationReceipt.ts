import type { Clock } from '../domain/clock';
import { calculateUsableStock } from '../domain/stock';
import { calculateShortfall } from '../domain/shortfall';
import { checkCandidateCompatibility, checkInboundEligibility } from '../domain/deadline';
import { evaluateApprovalRequirement } from '../domain/policy';
import { getRecoveryCandidateIssue } from '../domain/recoveryCandidate';
import { parseExtractedArrivalToWatIso } from '../domain/arrivalParser';
import { formatWat, weekdayWat } from '../domain/time';
import { formatQuantityWithUnit } from '../domain/itemUnit';
import {
  validateDecisionReceipt,
  type DecisionReceipt,
  type IgnoredInstructionSpan,
  type ScoutRecord,
  type SourceRevisionRef,
  type CandidateRemedy
} from '../domain/receipt';
import { DEMO_TRANSPORT_BUFFER_MINUTES } from '../demo/seedData';
import type { EvidenceSnapshot, SourceRecordEnvelope } from '../integrations/sources/types';
import type {
  ModelCallMetrics,
  VerifiedExtractionBundle
} from '../integrations/nvidia/extractionAgent';
import type { LookupTrace } from './lookupPlan';
import type { WorldModelReference } from '../domain/worldModel';

export type ExtractionOutcome =
  | { ok: true; bundle: VerifiedExtractionBundle }
  | { ok: false; error: Error; metrics: ModelCallMetrics };

export function snapshotToSourceRevisions(
  snapshot: EvidenceSnapshot,
  options: { includeBackup?: boolean } = {}
): SourceRevisionRef[] {
  const { orders, inventory, inboundShipments, supplierUpdates, backupListing } = snapshot.sources;
  const cited: Array<[SourceRevisionRef['sourceType'], SourceRecordEnvelope<unknown> | undefined]> =
    [
      ['orders', orders],
      ['inventory', inventory],
      ['supplier_updates', supplierUpdates],
      ['inbound_shipments', inboundShipments],
      ['backup_listings', options.includeBackup === false ? undefined : backupListing]
    ];
  return cited.flatMap(([sourceType, envelope]) =>
    envelope
      ? [
          {
            sourceType,
            revisionId: envelope.revisionId,
            recordId: envelope.recordId,
            snapshotHash: envelope.snapshotHash,
            backingSystem: envelope.backingSystem,
            timestampIso: envelope.timestampIso
          }
        ]
      : []
  );
}

/** Overlapping model/Scout detections refer to the same instruction, re-sliced from source. */
function mergeIgnoredSpans(
  sourceText: string,
  spans: IgnoredInstructionSpan[]
): IgnoredInstructionSpan[] {
  const merged: IgnoredInstructionSpan[] = [];
  for (const span of [...spans].sort((a, b) => a.startIndex - b.startIndex)) {
    const last = merged[merged.length - 1];
    if (last && span.startIndex < last.endIndex) {
      const endIndex = Math.max(last.endIndex, span.endIndex);
      merged[merged.length - 1] = {
        ...last,
        endIndex,
        text: sourceText.slice(last.startIndex, endIndex),
        detectedBy: [...new Set([...(last.detectedBy ?? []), ...(span.detectedBy ?? [])])].sort()
      };
    } else merged.push(span);
  }
  return merged;
}

/** True only for identities the World Model auto-merged or a manager approved. Pending loses. */
function resolvedSameSupplier(
  worldModel: WorldModelReference | undefined,
  inboundRecordId: string | undefined,
  backupRecordId: string
): string | undefined {
  if (!worldModel || !inboundRecordId) return undefined;
  const groupFor = (sourceType: string, recordId: string) =>
    worldModel.resolvedSuppliers.find((supplier) =>
      supplier.sourceRecords.some(
        (record) => record.sourceType === sourceType && record.recordId === recordId
      )
    );
  const inbound = groupFor('inbound_shipments', inboundRecordId);
  const backup = groupFor('backup_listings', backupRecordId);
  if (!inbound || !backup) return undefined;
  if (inbound.canonicalId !== backup.canonicalId) return undefined;
  if (inbound.status === 'pending_review' || backup.status === 'pending_review') return undefined;
  return inbound.names.join(' / ');
}

/** Pure receipt construction shared by successful and incomplete investigations. No persistence. */
export function buildInvestigationReceipt(input: {
  snapshot: EvidenceSnapshot;
  trace: LookupTrace;
  scout: ScoutRecord;
  scoutSpans: IgnoredInstructionSpan[];
  outcome: ExtractionOutcome;
  clock: Clock;
  version: number;
  worldModel?: WorldModelReference;
}): DecisionReceipt {
  const { snapshot, trace, scout, scoutSpans, outcome, clock, version, worldModel } = input;
  const order = snapshot.sources.orders.data;
  const inventory = snapshot.sources.inventory.data;
  const supplier = snapshot.sources.supplierUpdates.data;
  const inbound = snapshot.sources.inboundShipments?.data;
  const backup = snapshot.sources.backupListing?.data;
  const backupAvailability = snapshot.sources.backupAvailability;
  const metrics = outcome.ok ? outcome.bundle.metrics : outcome.metrics;
  const stock = calculateUsableStock(inventory);
  const latestEligibleArrivalIso = new Date(
    new Date(order.deliveryDeadlineIso).getTime() - DEMO_TRANSPORT_BUFFER_MINUTES * 60_000
  ).toISOString();
  const constraints = {
    orderSku: order.sku,
    deliveryDeadlineIso: order.deliveryDeadlineIso,
    transportBufferMinutes: DEMO_TRANSPORT_BUFFER_MINUTES,
    clock
  };
  const uncertainties: string[] = outcome.ok
    ? [...outcome.bundle.extraction.uncertainties]
    : [
        `Model/extraction failure: ${outcome.error.message}`,
        'Unstructured supplier message could not be verified; incoming stock treated as 0 eligible until resolved.'
      ];
  let eligibleIncomingQuantity = 0;
  let supplierExpectedArrivalIso = outcome.ok ? 'AMBIGUOUS_TIME' : 'UNVERIFIED';
  if (outcome.ok) {
    const extraction = outcome.bundle.extraction;
    const parsed = parseExtractedArrivalToWatIso(extraction.revisedArrivalText, clock);
    if (parsed.isAmbiguous || !parsed.arrivalIso) {
      uncertainties.push(
        `Supplier arrival time ambiguity: ${parsed.ambiguityReason || extraction.revisedArrivalText}`
      );
    } else {
      supplierExpectedArrivalIso = parsed.arrivalIso;
      const check = checkInboundEligibility(
        {
          shipmentId: inbound?.shipmentId || supplier.messageId,
          sku: order.sku,
          quantity: extraction.delayedQuantity,
          expectedArrivalIso: parsed.arrivalIso,
          status: inbound?.status === 'scheduled' ? 'confirmed' : 'unconfirmed'
        },
        constraints
      );
      eligibleIncomingQuantity = check.eligibleQuantity;
      if (!check.isEligible && check.ineligibilityReason)
        uncertainties.push(
          `Original supplier's ${formatQuantityWithUnit(extraction.delayedQuantity, order.sku)} arrive ${formatWat(parsed.arrivalIso)}, after the latest usable arrival ${formatWat(check.latestEligibleArrivalIso)}.`
        );
    }
  }
  if (trace.results['inbound.read']?.status === 'error')
    uncertainties.push(
      'Inbound commitment could not be verified; it contributes no eligible incoming stock.'
    );
  const shortfall = calculateShortfall({
    requiredQuantity: order.requiredQuantity,
    usableLocalStock: stock.usableAvailable,
    eligibleIncomingStock: eligibleIncomingQuantity
  });
  let candidate: CandidateRemedy | null = null;
  // A healthy order cites no remedy and no backup revision; a later lot change cannot make it stale.
  if (backup && shortfall.hasShortage) {
    const reservedByOrders = [
      ...new Set((backupAvailability?.reservations ?? []).map((r) => r.orderId))
    ];
    candidate = {
      listingId: backup.listingId,
      revisionId: backup.revisionId,
      supplierName: backup.supplierName,
      sku: backup.sku,
      availableQuantity: backupAvailability?.availableQuantity ?? backup.availableQuantity,
      advertisedQuantity: backup.availableQuantity,
      reservedQuantity: backupAvailability?.reservedQuantity ?? 0,
      reservedByOrders,
      statedDeliveryArrivalIso: backup.statedDeliveryArrivalIso,
      costKobo: backup.costKobo,
      isConfirmedReservation: false,
      isEligibleByDeadline: checkCandidateCompatibility(
        { sku: backup.sku, expectedArrivalIso: backup.statedDeliveryArrivalIso },
        constraints
      ).isCompatible
    };
    if (backupAvailability && backupAvailability.reservedQuantity > 0) {
      uncertainties.push(
        `Shared backup stock: ${formatQuantityWithUnit(backupAvailability.reservedQuantity, backup.sku)} already reserved by ${reservedByOrders.join(', ')}; ${formatQuantityWithUnit(backupAvailability.availableQuantity, backup.sku)} of ${backupAvailability.advertisedQuantity} available.`
      );
    }
    const sameSupplier = resolvedSameSupplier(worldModel, inbound?.shipmentId, backup.listingId);
    if (sameSupplier) {
      uncertainties.push(
        `World Model resolves the inbound supplier and the backup listing to one identity (${sameSupplier}); the backup lot may not be separate stock.`
      );
    }
    uncertainties.push(
      'Backup supplier listing is candidate availability, NOT a confirmed reservation. Supplier confirmation required after approval.'
    );
  } else if (!trace.results['backup_listings.read']) {
    if (shortfall.hasShortage)
      uncertainties.push('No backup lookup was requested; no backup candidate has been evaluated.');
  } else {
    uncertainties.push(
      trace.results['backup_listings.read'].status === 'error'
        ? `Backup lookup failed: ${trace.results['backup_listings.read'].outcomeSummary}`
        : `No approved backup supplier listing found for SKU ${order.sku}.`
    );
  }
  const candidateIssue = getRecoveryCandidateIssue(candidate, {
    ...constraints,
    shortfallQuantity: shortfall.shortfall
  });
  if (candidateIssue && shortfall.hasShortage) uncertainties.push(candidateIssue.message);
  const extraCostKobo = shortfall.hasShortage ? (candidate?.costKobo ?? 0) : 0;
  const policy = evaluateApprovalRequirement(extraCostKobo, trace.results['policy.read']?.policy);
  const ignoredSpans = outcome.ok
    ? mergeIgnoredSpans(supplier.rawMessageText, [
        ...outcome.bundle.resolvedIgnoredInstructions.map((span) => ({
          ...span,
          detectedBy: ['model' as const]
        })),
        ...scoutSpans
      ])
    : scoutSpans;
  return validateDecisionReceipt({
    receiptId: `RCP-${order.orderId}-01`,
    version,
    orderId: order.orderId,
    scenarioClockIso: clock.nowIso(),
    createdAtIso: clock.nowIso(),
    status: outcome.ok
      ? !shortfall.hasShortage
        ? 'on_track'
        : candidateIssue
          ? 'proposed'
          : 'awaiting_approval'
      : 'incomplete',
    executionMode: metrics.executionMode,
    modelRun: {
      model: metrics.model,
      latencyMs: metrics.latencyMs,
      totalTokens: metrics.totalTokens,
      attemptId: metrics.attemptId
    },
    scout,
    worldModel,
    sourceRevisions: snapshotToSourceRevisions(snapshot, { includeBackup: Boolean(candidate) }),
    investigationSteps: trace.steps,
    candidateRemedy: candidate,
    calculations: {
      sku: order.sku,
      requiredQuantity: order.requiredQuantity,
      physicallyPresent: stock.physicallyPresent,
      damaged: stock.damaged,
      activeAllocations: stock.activeAllocations,
      usableAvailable: stock.usableAvailable,
      eligibleIncoming: eligibleIncomingQuantity,
      shortfall: shortfall.shortfall,
      hasShortage: shortfall.hasShortage
    },
    timing: {
      deliveryDeadlineIso: order.deliveryDeadlineIso,
      transportBufferMinutes: DEMO_TRANSPORT_BUFFER_MINUTES,
      latestEligibleArrivalIso,
      supplierExpectedArrivalIso
    },
    financial: {
      currency: 'NGN',
      extraCostKobo,
      approvalThresholdKobo: policy.thresholdKobo,
      requiresManagerApproval: policy.requiresManagerApproval,
      policyExplanation: policy.explanation
    },
    agentFindings: {
      headline: outcome.ok
        ? shortfall.hasShortage
          ? `${formatQuantityWithUnit(shortfall.shortfall, order.sku)} short for ${weekdayWat(order.deliveryDeadlineIso)}`
          : `No shortfall — ${formatQuantityWithUnit(order.requiredQuantity, order.sku)} covered for ${weekdayWat(order.deliveryDeadlineIso)}`
        : 'Investigation incomplete — supplier message extraction failed',
      findingExplanation: outcome.ok
        ? outcome.bundle.extraction.findingExplanation
        : `Local warehouse has ${stock.usableAvailable} usable units of ${order.requiredQuantity} required, but supplier text extraction did not complete.`,
      extractedQuotes: outcome.ok
        ? outcome.bundle.resolvedQuotes.map((quote) => ({
            sourceType: 'supplier_updates' as const,
            quote: quote.text,
            claim: quote.claim,
            recordId: quote.recordId,
            startIndex: quote.startIndex,
            endIndex: quote.endIndex
          }))
        : [],
      ignoredInstructions: ignoredSpans.map((span) => span.text),
      ignoredInstructionSpans: ignoredSpans,
      uncertainties
    }
  });
}
