import { NextResponse } from 'next/server';
import { getStateStore, DEMO_RECEIPT_ID } from '@/src/server/stateStore';
import { resolveSession, withSessionCookie, type RequestSession } from '@/src/server/session';
import { errorResponse } from '@/src/server/http';
import { DEMO_ORDER } from '@/src/demo/seedData';
import { formatRecoveryStatusLabel } from '@/src/domain/state';

/** Everything the desk renders, read from the sources and the app database. */
export async function GET(req: Request) {
  let session: RequestSession | undefined;
  try {
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    await stateStore.ensureInitialized();
    // One read of the sources serves both the page and the staleness check, so out-of-band
    // source edits are still detected and a stale plan is never shown as current.
    const snapshot = await stateStore.sources.fetchEvidenceSnapshot(
      DEMO_ORDER.orderId,
      stateStore.clock.nowIso()
    );
    await stateStore.invalidateIfSourcesChanged(DEMO_RECEIPT_ID, session.user, snapshot);

    const recovery = stateStore.recoveryService;
    const receipt = recovery.getReceipt(DEMO_RECEIPT_ID) ?? null;
    const hasApprovedPlan =
      receipt && ['approved', 'awaiting_confirmation', 'confirmed'].includes(receipt.status);
    const confirmation =
      receipt?.status === 'confirmed' ? recovery.getConfirmation(DEMO_RECEIPT_ID) : undefined;

    return withSessionCookie(
      NextResponse.json({
        scenarioClockIso: stateStore.clock.nowIso(),
        isDemo: true,
        currentUser: session.user,
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
        statusLabel: receipt
          ? formatRecoveryStatusLabel(receipt.status, receipt.financial.requiresManagerApproval)
          : null,
        receiptHistory: recovery.getReceiptHistory(DEMO_RECEIPT_ID),
        modelBudget: stateStore.investigationService.modelUsage.summary(),
        approval: hasApprovedPlan ? (recovery.getApproval(DEMO_RECEIPT_ID) ?? null) : null,
        tasks: hasApprovedPlan ? recovery.getTasks(DEMO_RECEIPT_ID) : [],
        supplierDraft: hasApprovedPlan
          ? (recovery.getSupplierDraft(DEMO_RECEIPT_ID) ?? null)
          : null,
        confirmation: confirmation?.receiptVersion === receipt?.version ? confirmation : null,
        auditEvents: recovery.getAuditEvents(DEMO_RECEIPT_ID)
      }),
      session
    );
  } catch (err) {
    return errorResponse(session, err);
  }
}
