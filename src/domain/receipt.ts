import { z } from 'zod';
import { WorldModelReferenceSchema } from './worldModel';

export const SourceTypeSchema = z.enum([
  'orders',
  'inventory',
  'inbound_shipments',
  'supplier_updates',
  'backup_listings'
]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

export const SourceRevisionRefSchema = z.object({
  sourceType: SourceTypeSchema,
  revisionId: z.string(),
  recordId: z.string(),
  snapshotHash: z.string().optional(),
  backingSystem: z.string().optional(),
  timestampIso: z.string().optional()
});
export type SourceRevisionRef = z.infer<typeof SourceRevisionRefSchema>;

export const ExtractedQuoteSchema = z.object({
  sourceType: SourceTypeSchema,
  quote: z.string(),
  claim: z.string(),
  recordId: z.string().optional(),
  startIndex: z.number().int().nonnegative().optional(),
  endIndex: z.number().int().nonnegative().optional()
});
export type ExtractedQuote = z.infer<typeof ExtractedQuoteSchema>;

export const IgnoredInstructionSpanSchema = z.object({
  text: z.string(),
  recordId: z.string(),
  startIndex: z.number().int().nonnegative(),
  endIndex: z.number().int().nonnegative(),
  /** Which checks independently found this span: the model extraction and/or the Scout guard. */
  detectedBy: z.array(z.enum(['model', 'scout'])).optional()
});

/** What Scout (Meterless spec, Dispatch implementation) decided for this investigation. */
export const ScoutRecordSchema = z.object({
  contractId: z.string(),
  traceId: z.string(),
  intent: z.string(),
  confidence: z.number(),
  band: z.string(),
  capabilities: z.array(z.string()),
  issuedAt: z.string(),
  expiresAt: z.string(),
  registryVersion: z.number().int(),
  policyPackVersion: z.string(),
  supplierScreen: z.object({
    level: z.enum(['low', 'medium', 'high', 'block']),
    flags: z.array(
      z.object({ kind: z.string(), reason: z.string(), evidence: z.array(z.string()) })
    )
  })
});
export type ScoutRecord = z.infer<typeof ScoutRecordSchema>;
export type IgnoredInstructionSpan = z.infer<typeof IgnoredInstructionSpanSchema>;

export const AllowlistedLookupToolSchema = z.enum([
  'get_order',
  'get_inventory',
  'get_inbound',
  'get_supplier_messages',
  'get_backup_listings',
  'get_policy'
]);
export type AllowlistedLookupTool = z.infer<typeof AllowlistedLookupToolSchema>;

export const InvestigationStepSchema = z.object({
  stepIndex: z.number().int().positive(),
  tool: AllowlistedLookupToolSchema,
  args: z.record(z.string(), z.string()),
  sourceId: z.string(),
  revisionId: z.string(),
  recordId: z.string(),
  status: z.enum(['ok', 'missing', 'error']),
  outcomeSummary: z.string(),
  /** The Scout execution contract this lookup was verified against. */
  contractId: z.string().optional(),
  selectedBy: z.enum(['scout', 'model']).optional(),
  selectionReason: z.string().max(240).optional()
});
export type InvestigationStep = z.infer<typeof InvestigationStepSchema>;

export const CandidateRemedySchema = z.object({
  listingId: z.string(),
  revisionId: z.string(),
  supplierName: z.string(),
  sku: z.string(),
  availableQuantity: z.number().int().nonnegative(),
  statedDeliveryArrivalIso: z.string(),
  costKobo: z.number().int().nonnegative(),
  isConfirmedReservation: z.literal(false),
  // Historical JSON name: compatibility also checks SKU/unit. Approval recomputes it.
  isEligibleByDeadline: z.boolean(),
  /** Source lot size before reservations. Absent on receipts saved before shared lots existed. */
  advertisedQuantity: z.number().int().nonnegative().optional(),
  /** Units already held by other approved plans when this receipt was built. */
  reservedQuantity: z.number().int().nonnegative().optional(),
  reservedByOrders: z.array(z.string()).optional()
});
export type CandidateRemedy = z.infer<typeof CandidateRemedySchema>;

export const DecisionReceiptSchema = z.object({
  receiptId: z.string(),
  version: z.number().int().positive(),
  orderId: z.string(),
  scenarioClockIso: z.string(),
  createdAtIso: z.string(),
  status: z.enum([
    'detected',
    'proposed',
    'awaiting_approval',
    'approved',
    'awaiting_confirmation',
    'confirmed',
    'on_track',
    'rejected',
    'stale',
    'incomplete',
    'failed'
  ]),
  /** Why a stale receipt stopped being current; absent on plans invalidated before this field. */
  invalidatedReason: z.enum(['source_change', 'backup_conflict']).optional(),
  executionMode: z.enum(['live', 'mock', 'incomplete']).optional(),
  modelRun: z
    .object({
      model: z.string(),
      latencyMs: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative().optional(),
      attemptId: z.string().optional()
    })
    .optional(),
  scout: ScoutRecordSchema.optional(),
  /** Event and resolved supplier identities used when this receipt was built. */
  worldModel: WorldModelReferenceSchema.optional(),
  sourceRevisions: z.array(SourceRevisionRefSchema),
  investigationSteps: z.array(InvestigationStepSchema).optional(),
  candidateRemedy: CandidateRemedySchema.nullable().optional(),
  calculations: z.object({
    sku: z.string(),
    requiredQuantity: z.number().int().nonnegative(),
    physicallyPresent: z.number().int().nonnegative(),
    damaged: z.number().int().nonnegative(),
    activeAllocations: z.number().int().nonnegative(),
    usableAvailable: z.number().int().nonnegative(),
    eligibleIncoming: z.number().int().nonnegative(),
    shortfall: z.number().int().nonnegative(),
    hasShortage: z.boolean()
  }),
  timing: z.object({
    deliveryDeadlineIso: z.string(),
    transportBufferMinutes: z.number().int().nonnegative(),
    latestEligibleArrivalIso: z.string(),
    supplierExpectedArrivalIso: z.string()
  }),
  financial: z.object({
    currency: z.literal('NGN'),
    extraCostKobo: z.number().int().nonnegative(),
    approvalThresholdKobo: z.number().int().nonnegative(),
    requiresManagerApproval: z.boolean(),
    policyExplanation: z.string()
  }),
  agentFindings: z.object({
    headline: z.string(),
    findingExplanation: z.string().optional(),
    extractedQuotes: z.array(ExtractedQuoteSchema),
    ignoredInstructions: z.array(z.string()),
    ignoredInstructionSpans: z.array(IgnoredInstructionSpanSchema).optional(),
    uncertainties: z.array(z.string())
  })
});

export type DecisionReceipt = z.infer<typeof DecisionReceiptSchema>;

/**
 * Validates a Decision Receipt at the boundary using Zod.
 */
export function validateDecisionReceipt(data: unknown): DecisionReceipt {
  return DecisionReceiptSchema.parse(data);
}
