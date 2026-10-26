import type { DecisionReceipt } from '../domain/receipt';
import type { UserRole, UserSession } from '../domain/policy';
import type {
  ApprovalRecord,
  AuditEventRecord,
  InternalRecoveryTask,
  SupplierConfirmationRecord,
  SupplierRequestDraft
} from '../domain/recoveryRecords';
import type { EvidenceSnapshot, SourceRecordEnvelope } from '../integrations/sources/types';
import type { ModelBudgetSummary } from '../persistence/modelUsageLedger';

type Sources = EvidenceSnapshot['sources'];

/** The GET /api/state payload: everything the desk renders. */
export interface DeskState {
  scenarioClockIso: string;
  isDemo: true;
  currentUser: UserSession;
  integrations: {
    sources: EvidenceSnapshot['providerMode'];
    extraction: { mode: 'live' | 'mock'; model: string };
    scout: { implementation: string };
  };
  sources: {
    providerMode: EvidenceSnapshot['providerMode'];
    topology: EvidenceSnapshot['topology'];
    orders: Sources['orders'];
    inventory: Sources['inventory'];
    inboundShipments: NonNullable<Sources['inboundShipments']> | null;
    supplierUpdates: Sources['supplierUpdates'];
    backupListing: NonNullable<Sources['backupListing']> | null;
  };
  receipt: DecisionReceipt | null;
  statusLabel: string | null;
  receiptHistory: DecisionReceipt[];
  modelBudget: ModelBudgetSummary;
  approval: ApprovalRecord | null;
  tasks: InternalRecoveryTask[];
  supplierDraft: SupplierRequestDraft | null;
  confirmation: SupplierConfirmationRecord | null;
  auditEvents: AuditEventRecord[];
}

export type AnySourceEnvelope = SourceRecordEnvelope<unknown>;

export interface ConfirmationInput {
  supplierName: string;
  sku: string;
  confirmedQuantity: number;
  confirmedArrivalIso: string;
  confirmationReference: string;
  evidenceExcerpt: string;
}

export type SourceChange =
  | { sourceType: 'inventory'; damaged: number }
  | { sourceType: 'supplier_updates'; rawMessageText: string };

export type { DecisionReceipt, UserRole };
