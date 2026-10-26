import type { DecisionReceipt } from './receipt';
import type { UserRole } from './policy';

export interface InternalRecoveryTask {
  taskId: string;
  orderId: string;
  receiptId: string;
  receiptVersion: number;
  title: string;
  assignedRole: 'warehouse' | 'procurement' | 'dispatch';
  status: 'pending' | 'completed';
  createdAtIso: string;
}

export interface SupplierRequestDraft {
  draftId: string;
  orderId: string;
  receiptId: string;
  receiptVersion: number;
  supplierName: string;
  sku: string;
  requestedQuantity: number;
  offeredCostKobo: number;
  requiredDeliveryByIso: string;
  status: 'draft_prepared' | 'ready_for_operator_review';
  isSent: false;
  bodyText: string;
  createdAtIso: string;
}

export interface ApprovalRecord {
  approvalId: string;
  receiptId: string;
  receiptVersion: number;
  approvedByUserId: string;
  approvedByName: string;
  approvedByRole: UserRole;
  idempotencyKey: string;
  approvedAtIso: string;
}

export interface SupplierConfirmationInput {
  supplierName: string;
  sku: string;
  confirmedQuantity: number;
  confirmedArrivalIso: string;
  confirmationReference: string;
  evidenceExcerpt: string;
}

export interface SupplierConfirmationRecord {
  confirmationId: string;
  receiptId: string;
  receiptVersion: number;
  supplierName: string;
  sku: string;
  confirmedQuantity: number;
  confirmedArrivalIso: string;
  confirmationReference: string;
  evidenceExcerpt: string;
  simulated: true;
  recordedByUserId: string;
  recordedByName: string;
  recordedByRole: UserRole;
  recordedAtIso: string;
}

export interface AuditEventRecord {
  eventId: string;
  orderId: string;
  receiptId: string | null;
  receiptVersion: number | null;
  eventType: string;
  actorUserId: string;
  actorName: string;
  actorRole: string;
  scenarioTimeIso: string;
  wallClockIso: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface ApprovalResult {
  receipt: DecisionReceipt;
  approval: ApprovalRecord;
  tasks: InternalRecoveryTask[];
  supplierDraft: SupplierRequestDraft;
  isIdempotentReplay: boolean;
}
