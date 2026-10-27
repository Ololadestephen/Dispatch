import { z } from 'zod';

/** A source record that mentions a supplier name. */
export const WorldSourceRecordSchema = z.object({
  sourceType: z.string(),
  recordId: z.string(),
  name: z.string(),
  revisionId: z.string(),
  backingSystem: z.string()
});
export type WorldSourceRecord = z.infer<typeof WorldSourceRecordSchema>;

/**
 * One supplier identity in the World Model. Names in `names` are only in this group when the
 * reference implementation auto-merged them or a manager approved the merge. A pending pair stays
 * as two groups so deterministic checks cannot silently treat the names as one supplier.
 */
export const ResolvedSupplierSchema = z.object({
  canonicalId: z.string(),
  canonicalName: z.string(),
  names: z.array(z.string()),
  status: z.enum(['single', 'merged', 'pending_review']),
  pendingProposalId: z.string().optional(),
  sourceRecords: z.array(WorldSourceRecordSchema)
});
export type ResolvedSupplier = z.infer<typeof ResolvedSupplierSchema>;

export const WorldContextQuerySchema = z.object({
  contractId: z.string(),
  subjectEntityId: z.string(),
  relations: z.array(z.string()),
  limit: z.number().int().positive(),
  entityIds: z.array(z.string())
});

/** The event and resolved identities a receipt used. Additive so older receipts still validate. */
export const WorldModelReferenceSchema = z.object({
  namespace: z.string(),
  runId: z.string(),
  eventId: z.string(),
  eventSeq: z.number().int().nonnegative(),
  contextEntityId: z.string(),
  resolvedSuppliers: z.array(ResolvedSupplierSchema),
  contextQuery: WorldContextQuerySchema.optional()
});
export type WorldModelReference = z.infer<typeof WorldModelReferenceSchema>;

export const WorldEntitySchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string().nullable(),
  aliases: z.array(z.string())
});
export type WorldEntity = z.infer<typeof WorldEntitySchema>;

export const WorldNeighbourSchema = z.object({
  via: z.string(),
  hop: z.number().int().positive(),
  entity: WorldEntitySchema
});
export type WorldNeighbour = z.infer<typeof WorldNeighbourSchema>;

/** Everything the Investigation tab shows about the order's World Model context. */
export const WorldModelContextSchema = z.object({
  order: WorldEntitySchema,
  neighbours: z.array(WorldNeighbourSchema),
  suppliers: z.array(ResolvedSupplierSchema),
  eventId: z.string(),
  eventSeq: z.number().int().nonnegative()
});
export type WorldModelContext = z.infer<typeof WorldModelContextSchema>;

export const WorldMatchSchema = z.object({
  proposalId: z.string(),
  leftName: z.string(),
  rightName: z.string(),
  similarity: z.number(),
  status: z.enum(['pending', 'approved', 'rejected']),
  proposedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolvedBy: z.string().optional()
});
export type WorldMatch = z.infer<typeof WorldMatchSchema>;

export const WorldModelStateSchema = z.object({
  implementation: z.literal('Meterless World Model (reference implementation)'),
  storage: z.enum(['local', 'memory']),
  namespace: z.string(),
  eventCount: z.number().int().nonnegative(),
  entityCount: z.number().int().nonnegative(),
  headEventId: z.string(),
  headEventSeq: z.number().int().nonnegative(),
  pendingMatches: z.array(WorldMatchSchema),
  recentMatches: z.array(WorldMatchSchema),
  context: WorldModelContextSchema.nullable()
});
export type WorldModelState = z.infer<typeof WorldModelStateSchema>;
