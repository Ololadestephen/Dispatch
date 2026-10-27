import { DecisionReceipt, SourceRevisionRef, validateDecisionReceipt } from '../domain/receipt';
import {
  UserSession,
  evaluateApprovalRequirement,
  verifyApprovalAuthorization,
  formatNaira
} from '../domain/policy';
import type {
  InternalRecoveryTask,
  SupplierRequestDraft,
  ApprovalRecord,
  SupplierConfirmationInput,
  SupplierConfirmationRecord,
  ApprovalResult
} from '../domain/recoveryRecords';
import { formatRecoveryStatusLabel, validateRecoveryTransition } from '../domain/state';
import { formatWat } from '../domain/time';
import { DomainError, VersionConflictError } from '../domain/errors';
import { Clock } from '../domain/clock';
import { getRecoveryCandidateIssue } from '../domain/recoveryCandidate';
import { RecoveryStore } from '../persistence/recoveryStore';
import type { BackupAvailability, BackupReservationRecord } from '../domain/reservation';
import { supplierMatchesPlan } from '../domain/supplierIdentity';

export class RecoveryService {
  constructor(
    private readonly clock: Clock,
    private readonly store = new RecoveryStore()
  ) {}

  public get database() {
    return this.store.database;
  }

  /**
   * Appends the next validated receipt version and its audit event atomically.
   * @throws ZodError for an invalid receipt; VERSION_CONFLICT for a non-next version.
   * Stored-record/SQLite failures and assertActive errors propagate. A failure in the
   * transaction rolls back both writes, including expiration immediately before commit.
   */
  saveReceipt(
    receipt: DecisionReceipt,
    actor?: UserSession,
    assertActive?: () => void
  ): DecisionReceipt {
    const validated = validateDecisionReceipt(receipt);
    const existing = this.getReceipt(validated.receiptId);
    const expectedVersion = existing ? existing.version + 1 : 1;
    if (validated.version !== expectedVersion) {
      throw new VersionConflictError(
        `Version conflict on receipt ${validated.receiptId}: expected v${expectedVersion}, got v${validated.version}`
      );
    }

    const nowIso = this.clock.nowIso();
    const executionMode = validated.executionMode ?? 'live';
    const effectiveActor: UserSession = actor ?? {
      userId: 'SYS-AGENT',
      name: 'Dispatch Investigation Service',
      role: 'operator'
    };

    this.store.transaction(() => {
      assertActive?.();
      if (
        existing &&
        !['approved', 'awaiting_confirmation', 'confirmed'].includes(validated.status)
      ) {
        this.store.releaseActiveReservations(
          validated.receiptId,
          validated.status === 'rejected' ? 'cancelled' : 'superseded',
          nowIso
        );
      }
      this.store.insertReceiptVersion(validated, nowIso);

      this.store.insertAuditEvent({
        orderId: validated.orderId,
        receiptId: validated.receiptId,
        receiptVersion: validated.version,
        eventType: 'receipt_saved',
        actor: effectiveActor,
        scenarioTimeIso: nowIso,
        summary: `Receipt v${validated.version}: ${formatRecoveryStatusLabel(validated.status, validated.financial.requiresManagerApproval)} (${executionMode} model output)`,
        details: {
          status: validated.status,
          executionMode,
          shortfall: validated.calculations.shortfall,
          extraCostKobo: validated.financial.extraCostKobo
        }
      });
      assertActive?.();
    });

    return validated;
  }

  getReceipt(receiptId: string) {
    return this.store.getReceipt(receiptId);
  }

  getReceiptHistory(receiptId: string) {
    return this.store.getReceiptHistory(receiptId);
  }

  getApproval(receiptId: string) {
    return this.store.getApproval(receiptId);
  }

  getTasks(receiptId: string) {
    return this.store.getTasks(receiptId);
  }

  getSupplierDraft(receiptId: string) {
    return this.store.getSupplierDraft(receiptId);
  }

  getConfirmation(receiptId: string) {
    return this.store.getConfirmation(receiptId);
  }

  getAuditEvents(receiptId?: string) {
    return this.store.getAuditEvents(receiptId);
  }

  /**
   * Appends an audit event that belongs to the workspace rather than one receipt. World Model
   * identity review is the first such action; it must not be linked to a fabricated order id.
   */
  recordWorkspaceEvent(
    actor: UserSession,
    event: { eventType: string; summary: string; details: Record<string, unknown> },
    idempotencyKey?: string
  ): void {
    this.store.transaction(() => {
      if (
        idempotencyKey &&
        this.store
          .getAuditEvents()
          .some((existing) => existing.details.idempotencyKey === idempotencyKey)
      )
        return;
      this.store.insertAuditEvent({
        orderId: 'WORKSPACE',
        receiptId: null,
        receiptVersion: null,
        eventType: event.eventType,
        actor,
        scenarioTimeIso: this.clock.nowIso(),
        summary: event.summary,
        details: { ...event.details, ...(idempotencyKey ? { idempotencyKey } : {}) }
      });
    });
  }

  /** Active shared-lot holds, optionally narrowed to one listing. */
  listActiveReservations(backupListingId?: string) {
    return this.store.listActiveReservations(backupListingId);
  }

  listReservations() {
    return this.store.listReservations();
  }

  /** Human cancellation releases stock and appends a rejected version; it sends nothing. */
  cancelPlan(params: {
    receiptId: string;
    expectedVersion: number;
    actor: UserSession;
    idempotencyKey: string;
    reason: string;
  }): { receipt: DecisionReceipt; isIdempotentReplay: boolean } {
    if (params.actor.role !== 'manager') {
      throw new DomainError('Only a manager can cancel a recovery plan.', 'FORBIDDEN_ROLE');
    }
    const reason = params.reason.trim();
    if (!reason || reason.length > 240)
      throw new DomainError(
        'A cancellation needs a reason of at most 240 characters.',
        'INVALID_REQUEST'
      );
    const key = `cancel:${params.receiptId}:v${params.expectedVersion}:${params.actor.userId}:${params.idempotencyKey}`;
    return this.store.transaction(() => {
      const previous = this.store.findIdempotentResponse<{ receipt: DecisionReceipt }>(key);
      if (previous) return { ...previous, isIdempotentReplay: true };
      const current = this.getReceipt(params.receiptId);
      if (!current) throw new DomainError('Recovery receipt not found.', 'RECEIPT_NOT_FOUND');
      if (current.version !== params.expectedVersion)
        throw new VersionConflictError('Plan changed. Refresh before cancelling.');
      validateRecoveryTransition(current.status, 'rejected');
      const receipt = validateDecisionReceipt({
        ...current,
        version: current.version + 1,
        status: 'rejected'
      });
      const at = this.clock.nowIso();
      const released = this.store.releaseActiveReservations(current.receiptId, 'cancelled', at);
      this.store.insertReceiptVersion(receipt, at);
      this.store.insertAuditEvent({
        orderId: current.orderId,
        receiptId: current.receiptId,
        receiptVersion: receipt.version,
        eventType: 'plan_cancelled',
        actor: params.actor,
        scenarioTimeIso: at,
        summary: `Plan v${current.version} cancelled: ${reason}`,
        details: {
          reason,
          releasedReservations: released.map((reservation) => reservation.reservationId)
        }
      });
      this.store.storeIdempotentResponse(
        key,
        current.receiptId,
        current.version,
        params.actor.userId,
        at,
        { receipt }
      );
      return { receipt, isIdempotentReplay: false };
    });
  }

  /**
   * The transaction-authoritative version check shared by approval and confirmation. A plan that
   * lost the lot to another order is reported as taken stock, not as an opaque stale version.
   */
  private assertVersionCurrent(receiptId: string, expectedVersion: number, message: string): void {
    const current = this.store.getReceipt(receiptId);
    if (!current) throw new DomainError('Recovery receipt not found.', 'RECEIPT_NOT_FOUND');
    if (current.version === expectedVersion) return;
    if (current.status === 'stale' && current.invalidatedReason === 'backup_conflict') {
      const reason =
        current.agentFindings.uncertainties.find((entry) =>
          entry.startsWith('Backup stock taken by')
        ) ?? 'Backup stock taken by another order — re-plan.';
      throw new DomainError(reason, 'BACKUP_STOCK_TAKEN');
    }
    throw new VersionConflictError(message);
  }

  /** Deterministic availability for one lot from the source's advertised quantity. */ getBackupAvailability(
    listingId: string,
    advertisedQuantity: number
  ): BackupAvailability {
    const reservations = this.store.listActiveReservations(listingId);
    const reservedQuantity = reservations.reduce((sum, r) => sum + r.quantity, 0);
    return {
      listingId,
      advertisedQuantity,
      reservedQuantity,
      availableQuantity: Math.max(0, advertisedQuantity - reservedQuantity),
      reservations
    };
  }

  /**
   * Applies spend policy before atomically appending approval, receipt, tasks and draft.
   * Replaying the same receipt/version/actor/key returns the original result with no writes.
   * @throws RECEIPT_NOT_FOUND, VERSION_CONFLICT, UNAUTHORIZED_APPROVAL or
   * INVALID_STATE_TRANSITION; NO_CANDIDATE_REMEDY, NO_SHORTFALL,
   * INSUFFICIENT_CANDIDATE_QUANTITY or a CANDIDATE_* error for an infeasible listing.
   * Stored-record/validation/SQLite errors propagate; failed transactions leave no actions.
   */
  approvePlan(params: {
    receiptId: string;
    expectedVersion: number;
    actor: UserSession;
    idempotencyKey: string;
  }): ApprovalResult {
    const { receiptId, expectedVersion, actor, idempotencyKey } = params;
    const scopedKey = `approve:${receiptId}:v${expectedVersion}:${actor.userId}:${idempotencyKey}`;
    const cached = this.store.findIdempotentResponse<ApprovalResult>(scopedKey);
    if (cached) return { ...cached, isIdempotentReplay: true };

    const receipt = this.getReceipt(receiptId);
    if (!receipt) {
      throw new DomainError(`Receipt with ID ${receiptId} not found`, 'RECEIPT_NOT_FOUND');
    }

    if (receipt.version !== expectedVersion) {
      throw new VersionConflictError(
        `Receipt ${receiptId} version mismatch. Expected ${expectedVersion}, but current is ${receipt.version}. Refresh and re-review.`
      );
    }

    const requirement = evaluateApprovalRequirement(receipt.financial.extraCostKobo, {
      policyId: 'POL-DEFAULT',
      name: 'Default Policy',
      thresholdKobo: receipt.financial.approvalThresholdKobo,
      currency: 'NGN'
    });
    verifyApprovalAuthorization(actor, requirement);

    validateRecoveryTransition(receipt.status, 'approved');

    if (!receipt.candidateRemedy) {
      throw new DomainError(
        `Receipt ${receiptId} has no candidate remedy; there is no supplier to draft a request for.`,
        'NO_CANDIDATE_REMEDY'
      );
    }
    const candidateIssue = getRecoveryCandidateIssue(receipt.candidateRemedy, {
      shortfallQuantity: receipt.calculations.shortfall,
      orderSku: receipt.calculations.sku,
      deliveryDeadlineIso: receipt.timing.deliveryDeadlineIso,
      transportBufferMinutes: receipt.timing.transportBufferMinutes,
      clock: this.clock
    });
    if (candidateIssue) throw new DomainError(candidateIssue.message, candidateIssue.code);

    const nowIso = this.clock.nowIso();
    const newVersion = receipt.version + 1;

    const updatedReceipt: DecisionReceipt = {
      ...receipt,
      version: newVersion,
      status: 'awaiting_confirmation'
    };
    validateDecisionReceipt(updatedReceipt);

    const approvalRecord: ApprovalRecord = {
      approvalId: `APR-${receiptId}-V${expectedVersion}`,
      receiptId,
      receiptVersion: expectedVersion,
      approvedByUserId: actor.userId,
      approvedByName: actor.name,
      approvedByRole: actor.role,
      idempotencyKey,
      approvedAtIso: nowIso
    };

    const reservation: BackupReservationRecord = {
      reservationId: `RSV-${receiptId}-V${newVersion}`,
      backupListingId: receipt.candidateRemedy.listingId,
      backupRevisionId: receipt.candidateRemedy.revisionId,
      sku: receipt.calculations.sku,
      orderId: receipt.orderId,
      receiptId,
      receiptVersion: newVersion,
      quantity: receipt.calculations.shortfall,
      status: 'active',
      idempotencyKey,
      createdAtIso: nowIso
    };

    const task1: InternalRecoveryTask = {
      taskId: `TSK-RESERVE-${receipt.orderId}-V${newVersion}`,
      orderId: receipt.orderId,
      receiptId,
      receiptVersion: newVersion,
      title: `Reserve ${receipt.calculations.usableAvailable} usable units in warehouse for ${receipt.orderId}`,
      assignedRole: 'warehouse',
      status: 'pending',
      createdAtIso: nowIso
    };

    const task2: InternalRecoveryTask = {
      taskId: `TSK-CHECKLIST-${receipt.orderId}-V${newVersion}`,
      orderId: receipt.orderId,
      receiptId,
      receiptVersion: newVersion,
      title: `Prepare outbound delivery checklist for ${formatWat(receipt.timing.deliveryDeadlineIso)}`,
      assignedRole: 'dispatch',
      status: 'pending',
      createdAtIso: nowIso
    };

    const createdTasks = [task1, task2];
    const supplierName = receipt.candidateRemedy.supplierName;
    const bodyText = `DRAFT — NOT SENT EXTERNALLY: Request ${receipt.calculations.shortfall} units of ${receipt.calculations.sku} from ${supplierName} at ${formatNaira(receipt.financial.extraCostKobo)}, required at warehouse by ${formatWat(receipt.timing.latestEligibleArrivalIso)}.`;

    const supplierDraft: SupplierRequestDraft = {
      draftId: `DFT-SUP-${receipt.orderId}-V${newVersion}`,
      orderId: receipt.orderId,
      receiptId,
      receiptVersion: newVersion,
      supplierName,
      sku: receipt.calculations.sku,
      requestedQuantity: receipt.calculations.shortfall,
      offeredCostKobo: receipt.financial.extraCostKobo,
      requiredDeliveryByIso: receipt.timing.latestEligibleArrivalIso,
      status: 'draft_prepared',
      isSent: false,
      bodyText,
      createdAtIso: nowIso
    };

    const result: ApprovalResult = {
      receipt: updatedReceipt,
      approval: approvalRecord,
      tasks: createdTasks,
      supplierDraft,
      reservation,
      isIdempotentReplay: false
    };

    this.store.transaction(() => {
      // The version read above is only a fast rejection. The transaction is the authority: another
      // connection may have committed a new version between that read and this write.
      this.assertVersionCurrent(
        receiptId,
        expectedVersion,
        `Receipt ${receiptId} changed while approving. Refresh and re-review.`
      );
      // First approval commits. Re-reading active holds inside this transaction is the only
      // authority on what remains; an earlier deadline is a desk hint, never a pre-emption.
      const advertisedQuantity =
        receipt.candidateRemedy!.advertisedQuantity ?? receipt.candidateRemedy!.availableQuantity;
      const reservedBefore = this.store
        .listActiveReservations(reservation.backupListingId)
        .reduce((sum, r) => sum + r.quantity, 0);
      if (reservedBefore + reservation.quantity > advertisedQuantity) {
        const holders = [
          ...new Set(
            this.store
              .listActiveReservations(reservation.backupListingId)
              .map((r) => r.orderId)
              .filter((orderId) => orderId !== receipt.orderId)
          )
        ];
        throw new DomainError(
          holders.length > 0
            ? `Backup stock taken by ${holders.join(', ')} — re-plan.`
            : `Backup listing ${reservation.backupListingId} has only ${Math.max(0, advertisedQuantity - reservedBefore)} of ${reservation.quantity} units left.`,
          'BACKUP_STOCK_TAKEN'
        );
      }

      this.store.insertReservation(reservation);
      this.store.insertReceiptVersion(updatedReceipt, nowIso);

      this.store.insertApproval(approvalRecord);
      this.store.insertTasks(createdTasks);
      this.store.insertSupplierDraft(supplierDraft);

      this.invalidateCompetingPlans({
        winnerOrderId: receipt.orderId,
        reservation,
        advertisedQuantity,
        nowIso,
        actor
      });

      this.store.storeIdempotentResponse(
        scopedKey,
        receiptId,
        expectedVersion,
        actor.userId,
        nowIso,
        result
      );

      this.store.insertAuditEvent({
        orderId: updatedReceipt.orderId,
        receiptId: updatedReceipt.receiptId,
        receiptVersion: updatedReceipt.version,
        eventType: 'plan_approved',
        actor,
        scenarioTimeIso: nowIso,
        summary: `Approved plan v${expectedVersion}. Created ${createdTasks.length} tasks and an unsent supplier draft.`,
        details: {
          approvalId: approvalRecord.approvalId,
          approvedReceiptVersion: expectedVersion,
          newVersion: updatedReceipt.version,
          idempotencyKey,
          tasksCreated: createdTasks.map((t) => t.taskId),
          draftId: supplierDraft.draftId,
          reservationId: reservation.reservationId,
          backupListingId: reservation.backupListingId,
          reservedQuantity: reservation.quantity,
          advertisedQuantity,
          reservedBefore
        }
      });
    });

    return result;
  }

  /**
   * After a winning approval, other unapproved plans citing the same lot are stale only when the
   * remaining stock can no longer cover them. They re-investigate against the reduced quantity.
   */
  private invalidateCompetingPlans(params: {
    winnerOrderId: string;
    reservation: BackupReservationRecord;
    advertisedQuantity: number;
    nowIso: string;
    actor: UserSession;
  }): void {
    const { winnerOrderId, reservation, advertisedQuantity, nowIso, actor } = params;
    const remaining = Math.max(
      0,
      advertisedQuantity -
        this.store
          .listActiveReservations(reservation.backupListingId)
          .reduce((sum, r) => sum + r.quantity, 0)
    );
    const reason = `Backup stock taken by ${winnerOrderId} — re-plan.`;

    for (const other of this.store.listLatestReceipts()) {
      if (
        other.orderId === winnerOrderId ||
        !['proposed', 'awaiting_approval'].includes(other.status) ||
        other.candidateRemedy?.listingId !== reservation.backupListingId ||
        other.calculations.shortfall <= remaining
      ) {
        continue;
      }

      validateRecoveryTransition(other.status, 'stale');
      const updatedReceipt: DecisionReceipt = {
        ...other,
        version: other.version + 1,
        status: 'stale',
        invalidatedReason: 'backup_conflict',
        agentFindings: {
          ...other.agentFindings,
          uncertainties: [...other.agentFindings.uncertainties, reason]
        }
      };
      validateDecisionReceipt(updatedReceipt);
      const released = this.store.releaseActiveReservations(
        other.receiptId,
        'backup_conflict',
        nowIso
      );

      this.store.insertReceiptVersion(updatedReceipt, nowIso);
      this.store.insertAuditEvent({
        orderId: updatedReceipt.orderId,
        receiptId: updatedReceipt.receiptId,
        receiptVersion: updatedReceipt.version,
        eventType: 'plan_invalidated_backup_conflict',
        actor,
        scenarioTimeIso: nowIso,
        summary: `Plan v${other.version} marked stale: ${reason}`,
        details: {
          previousVersion: other.version,
          previousStatus: other.status,
          newVersion: updatedReceipt.version,
          reason,
          winningOrderId: winnerOrderId,
          backupListingId: reservation.backupListingId,
          remainingQuantity: remaining,
          releasedReservationIds: released.map((r) => r.reservationId)
        }
      });
    }
  }

  /**
   * Records a SIMULATED supplier confirmation (the demo has no real supplier channel).
   * The confirmation, new receipt, audit event and replay response commit atomically.
   * The same receipt/version/actor/key returns the original result without another write.
   * @throws RECEIPT_NOT_FOUND, VERSION_CONFLICT, INVALID_STATE_TRANSITION,
   * INSUFFICIENT_CONFIRMATION_QUANTITY, CONFIRMATION_SKU_MISMATCH, CONFIRMATION_LATE,
   * MISSING_EVIDENCE or CONFIRMATION_SUPPLIER_MISMATCH. Stored-record/validation/SQLite
   * failures propagate and roll back the transaction.
   */
  recordSupplierConfirmation(params: {
    receiptId: string;
    expectedVersion: number;
    actor: UserSession;
    idempotencyKey: string;
    confirmation: SupplierConfirmationInput;
  }): {
    receipt: DecisionReceipt;
    confirmation: SupplierConfirmationRecord;
    isIdempotentReplay: boolean;
  } {
    const { receiptId, expectedVersion, actor, idempotencyKey, confirmation } = params;
    const effectiveActor = actor;
    const scopedKey = `confirm:${receiptId}:v${expectedVersion}:${actor.userId}:${idempotencyKey}`;
    const cached = this.store.findIdempotentResponse<{
      receipt: DecisionReceipt;
      confirmation: SupplierConfirmationRecord;
    }>(scopedKey);
    if (cached) return { ...cached, isIdempotentReplay: true };

    const receipt = this.getReceipt(receiptId);
    if (!receipt) {
      throw new DomainError(`Receipt with ID ${receiptId} not found`, 'RECEIPT_NOT_FOUND');
    }

    if (receipt.version !== expectedVersion) {
      throw new VersionConflictError(
        `Receipt ${receiptId} version mismatch. Expected ${expectedVersion}, but current is ${receipt.version}.`
      );
    }

    validateRecoveryTransition(receipt.status, 'confirmed');

    if (confirmation.confirmedQuantity < receipt.calculations.shortfall) {
      throw new DomainError(
        `Confirmed quantity (${confirmation.confirmedQuantity}) is less than required shortfall (${receipt.calculations.shortfall})`,
        'INSUFFICIENT_CONFIRMATION_QUANTITY'
      );
    }

    if (confirmation.sku !== receipt.calculations.sku) {
      throw new DomainError(
        `Confirmed SKU (${confirmation.sku}) does not match order SKU (${receipt.calculations.sku})`,
        'CONFIRMATION_SKU_MISMATCH'
      );
    }

    const confirmedArrivalMs = new Date(confirmation.confirmedArrivalIso).getTime();
    const latestEligibleMs = new Date(receipt.timing.latestEligibleArrivalIso).getTime();
    if (Number.isNaN(confirmedArrivalMs) || confirmedArrivalMs > latestEligibleMs) {
      throw new DomainError(
        `Confirmed arrival (${confirmation.confirmedArrivalIso}) is invalid or after buffered deadline (${receipt.timing.latestEligibleArrivalIso})`,
        'CONFIRMATION_LATE'
      );
    }

    const nowIso = this.clock.nowIso();
    const newVersion = receipt.version + 1;

    const updatedReceipt: DecisionReceipt = {
      ...receipt,
      version: newVersion,
      status: 'confirmed'
    };
    validateDecisionReceipt(updatedReceipt);

    const evidenceExcerpt = confirmation.evidenceExcerpt.trim();
    if (!evidenceExcerpt) {
      throw new DomainError('A confirmation needs the supplier evidence text.', 'MISSING_EVIDENCE');
    }
    if (receipt.candidateRemedy && !supplierMatchesPlan(receipt, confirmation.supplierName)) {
      throw new DomainError(
        `Confirmation is from ${confirmation.supplierName}, but the approved plan uses ${receipt.candidateRemedy.supplierName}.`,
        'CONFIRMATION_SUPPLIER_MISMATCH'
      );
    }

    const confirmationId = `CNF-${receiptId}-V${newVersion}`;
    const confirmationRecord: SupplierConfirmationRecord = {
      confirmationId,
      receiptId,
      receiptVersion: newVersion,
      supplierName: confirmation.supplierName,
      sku: confirmation.sku,
      confirmedQuantity: confirmation.confirmedQuantity,
      confirmedArrivalIso: confirmation.confirmedArrivalIso,
      confirmationReference: confirmation.confirmationReference,
      evidenceExcerpt,
      simulated: true,
      recordedByUserId: actor.userId,
      recordedByName: actor.name,
      recordedByRole: actor.role,
      recordedAtIso: nowIso
    };

    this.store.transaction(() => {
      // Re-read inside the transaction: the pre-transaction check cannot see a concurrent commit.
      this.assertVersionCurrent(
        receiptId,
        expectedVersion,
        `Receipt ${receiptId} changed while recording the confirmation. Refresh and re-review.`
      );
      this.store.insertReceiptVersion(updatedReceipt, nowIso);

      this.store.insertConfirmation(confirmationRecord);

      this.store.insertAuditEvent({
        orderId: updatedReceipt.orderId,
        receiptId: updatedReceipt.receiptId,
        receiptVersion: updatedReceipt.version,
        eventType: 'supplier_confirmed',
        actor: effectiveActor,
        scenarioTimeIso: nowIso,
        summary: `Simulated confirmation ${confirmation.confirmationReference}: ${confirmation.confirmedQuantity} × ${confirmation.sku} by ${formatWat(confirmation.confirmedArrivalIso)}.`,
        details: {
          confirmationId,
          supplierName: confirmation.supplierName,
          confirmedQuantity: confirmation.confirmedQuantity,
          confirmedArrivalIso: confirmation.confirmedArrivalIso,
          confirmationReference: confirmation.confirmationReference,
          evidenceExcerpt,
          simulated: true
        }
      });

      this.store.storeIdempotentResponse(
        scopedKey,
        receiptId,
        expectedVersion,
        actor.userId,
        nowIso,
        {
          receipt: updatedReceipt,
          confirmation: confirmationRecord
        }
      );
    });

    return { receipt: updatedReceipt, confirmation: confirmationRecord, isIdempotentReplay: false };
  }

  /**
   * Appends a stale version and its audit event in one transaction.
   * @throws RECEIPT_NOT_FOUND or INVALID_STATE_TRANSITION; stored-record, validation
   * and SQLite failures propagate without partially appending history.
   */
  invalidatePlanOnSourceChange(
    receiptId: string,
    reason: string,
    actor?: UserSession
  ): DecisionReceipt {
    const receipt = this.getReceipt(receiptId);
    if (!receipt) {
      throw new DomainError(`Receipt ${receiptId} not found`, 'RECEIPT_NOT_FOUND');
    }

    validateRecoveryTransition(receipt.status, 'stale');

    const nowIso = this.clock.nowIso();
    const newVersion = receipt.version + 1;
    const effectiveActor: UserSession = actor ?? {
      userId: 'SYS-MONITOR',
      name: 'Source Revision Monitor',
      role: 'operator'
    };

    const updatedReceipt: DecisionReceipt = {
      ...receipt,
      version: newVersion,
      status: 'stale',
      invalidatedReason: 'source_change',
      agentFindings: {
        ...receipt.agentFindings,
        uncertainties: [...receipt.agentFindings.uncertainties, `Source invalidated: ${reason}`]
      }
    };
    validateDecisionReceipt(updatedReceipt);

    this.store.transaction(() => {
      const released = this.store.releaseActiveReservations(receiptId, 'source_change', nowIso);
      this.store.insertReceiptVersion(updatedReceipt, nowIso);

      this.store.insertAuditEvent({
        orderId: updatedReceipt.orderId,
        receiptId: updatedReceipt.receiptId,
        receiptVersion: updatedReceipt.version,
        eventType: 'plan_invalidated_stale',
        actor: effectiveActor,
        scenarioTimeIso: nowIso,
        summary: `Plan v${receipt.version} marked stale: ${reason}`,
        details: {
          previousVersion: receipt.version,
          previousStatus: receipt.status,
          newVersion: updatedReceipt.version,
          reason,
          releasedReservationIds: released.map((r) => r.reservationId)
        }
      });
    });

    return updatedReceipt;
  }

  /**
   * Compares cited revisions/hashes and appends one stale version when they differ.
   * Stale/incomplete receipts and unchanged sources return without another mutation.
   * @throws RECEIPT_NOT_FOUND; invalidation and stored-record/SQLite errors propagate
   * with the atomicity guarantees of invalidatePlanOnSourceChange.
   */
  checkAndInvalidateIfSourcesChanged(
    receiptId: string,
    currentSources: SourceRevisionRef[],
    actor?: UserSession
  ): { invalidated: boolean; receipt: DecisionReceipt; changedSources: string[] } {
    const receipt = this.getReceipt(receiptId);
    if (!receipt) {
      throw new DomainError(`Receipt ${receiptId} not found`, 'RECEIPT_NOT_FOUND');
    }

    if (receipt.status === 'stale' || receipt.status === 'incomplete') {
      return { invalidated: false, receipt, changedSources: [] };
    }

    const changedSources: string[] = [];
    for (const cited of receipt.sourceRevisions) {
      const current = currentSources.find(
        (s) => s.sourceType === cited.sourceType && s.recordId === cited.recordId
      );
      const hashChanged =
        Boolean(cited.snapshotHash) &&
        Boolean(current?.snapshotHash) &&
        cited.snapshotHash !== current?.snapshotHash;
      const revChanged = !current || current.revisionId !== cited.revisionId;

      if (revChanged || hashChanged) {
        changedSources.push(
          `${cited.sourceType}:${cited.recordId} (was ${cited.revisionId}/${(cited.snapshotHash ?? '').slice(0, 8)}, now ${current ? `${current.revisionId}/${(current.snapshotHash ?? '').slice(0, 8)}` : 'missing'})`
        );
      }
    }

    if (changedSources.length === 0) {
      return { invalidated: false, receipt, changedSources: [] };
    }

    const updated = this.invalidatePlanOnSourceChange(
      receiptId,
      `Source revision changed after plan generation: ${changedSources.join('; ')}`,
      actor
    );
    return { invalidated: true, receipt: updated, changedSources };
  }
}
