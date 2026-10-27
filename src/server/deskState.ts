import type { UserSession } from '../domain/policy';
import { DomainError } from '../domain/errors';
import { formatRecoveryStatusLabel } from '../domain/state';
import type { DeskState, OrderSummary } from '../client/deskState';
import type { StateStore } from './stateStore';

/** Receipt ids are stable per order, so a state read can find history without a source scan. */
export function receiptIdFor(orderId: string): string {
  return `RCP-${orderId}-01`;
}

/** GET /api/orders: every seeded order with its latest receipt status, or not investigated. */
export async function listOrderSummaries(stateStore: StateStore): Promise<OrderSummary[]> {
  const orders = await stateStore.sources.listOrders();
  return orders.map((order) => {
    const receipt = stateStore.recoveryService.getReceipt(receiptIdFor(order.orderId));
    return {
      orderId: order.orderId,
      customerName: order.customerName,
      eventName: order.eventName,
      itemDescription: order.itemDescription,
      sku: order.sku,
      requiredQuantity: order.requiredQuantity,
      deliveryDeadlineIso: order.deliveryDeadlineIso,
      operationalStatus: order.operationalStatus,
      receiptStatus: receipt?.status ?? null,
      receiptVersion: receipt?.version ?? null,
      statusLabel: receipt
        ? formatRecoveryStatusLabel(
            receipt.status,
            receipt.financial.requiresManagerApproval,
            receipt.invalidatedReason
          )
        : 'Not investigated',
      shortfall: receipt?.calculations.shortfall ?? null
    };
  });
}

/**
 * Builds the DeskState payload for one order. The snapshot read is reused for the staleness
 * check, so an out-of-band source edit is caught before a stale plan is shown as current.
 */
export async function buildOrderState(
  stateStore: StateStore,
  orderId: string,
  user: UserSession
): Promise<DeskState> {
  const order = await stateStore.sources.readOrderRecord(orderId);
  if (!order) {
    throw new DomainError(`Order ${orderId} does not exist in this workspace.`, 'ORDER_NOT_FOUND');
  }

  const receiptId = receiptIdFor(orderId);
  const snapshot = await stateStore.sources.fetchEvidenceSnapshot(
    orderId,
    stateStore.clock.nowIso()
  );
  await stateStore.invalidateIfSourcesChanged(receiptId, user, snapshot);
  await stateStore.worldModel.ingestSnapshot(
    snapshot,
    stateStore.recoveryService.listReservations()
  );

  const recovery = stateStore.recoveryService;
  const receipt = recovery.getReceipt(receiptId) ?? null;
  const hasApprovedPlan =
    receipt && ['approved', 'awaiting_confirmation', 'confirmed'].includes(receipt.status);
  const confirmation =
    receipt?.status === 'confirmed' ? recovery.getConfirmation(receiptId) : undefined;
  const candidate = receipt?.candidateRemedy;

  return {
    scenarioClockIso: stateStore.clock.nowIso(),
    isDemo: true,
    currentUser: user,
    integrations: {
      sources: snapshot.providerMode,
      extraction: stateStore.extraction,
      scout: { implementation: 'Meterless Scout Intent spec (Dispatch implementation)' }
    },
    sources: {
      providerMode: snapshot.providerMode,
      topology: snapshot.topology,
      orders: snapshot.sources.orders,
      inventory: snapshot.sources.inventory,
      inboundShipments: snapshot.sources.inboundShipments ?? null,
      supplierUpdates: snapshot.sources.supplierUpdates,
      backupListing: snapshot.sources.backupListing ?? null
    },
    receipt,
    worldModel: stateStore.worldModel.uiState(orderId),
    backupAvailability: candidate
      ? recovery.getBackupAvailability(
          candidate.listingId,
          candidate.advertisedQuantity ?? candidate.availableQuantity
        )
      : null,
    statusLabel: receipt
      ? formatRecoveryStatusLabel(
          receipt.status,
          receipt.financial.requiresManagerApproval,
          receipt.invalidatedReason
        )
      : null,
    receiptHistory: recovery.getReceiptHistory(receiptId),
    modelBudget: stateStore.investigationService.modelUsage.summary(),
    approval: hasApprovedPlan ? (recovery.getApproval(receiptId) ?? null) : null,
    tasks: hasApprovedPlan ? recovery.getTasks(receiptId) : [],
    supplierDraft: hasApprovedPlan ? (recovery.getSupplierDraft(receiptId) ?? null) : null,
    confirmation:
      confirmation && confirmation.receiptVersion === receipt?.version ? confirmation : null,
    auditEvents: recovery.getAuditEvents(receiptId)
  };
}
