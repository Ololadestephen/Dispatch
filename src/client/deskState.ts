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
import type { BackupAvailability } from '../domain/reservation';
import type { ModelBudgetSummary } from '../persistence/modelUsageLedger';
import type { WorldModelState } from '../domain/worldModel';

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
  /** The local World Model mirror for this order: review queue, context and event offset. */
  worldModel: WorldModelState;
  /** Live shared-lot availability for the receipt's candidate listing. */
  backupAvailability: BackupAvailability | null;
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

/** One row of GET /api/orders: the order plus its latest receipt, if it has been investigated. */
export interface OrderSummary {
  orderId: string;
  customerName: string;
  eventName: string;
  itemDescription: string;
  sku: string;
  requiredQuantity: number;
  deliveryDeadlineIso: string;
  operationalStatus: 'confirmed' | 'at_risk' | 'recovery_confirmed' | 'delivered';
  receiptStatus: DecisionReceipt['status'] | null;
  receiptVersion: number | null;
  statusLabel: string;
  shortfall: number | null;
}

export interface OrdersResponse {
  orders: OrderSummary[];
}

export interface ActivityResponse {
  events: AuditEventRecord[];
}

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
