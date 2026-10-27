/**
 * Type surface for the vendored Meterless World Model reference implementation.
 *
 * The runtime module is the unedited reference at
 * `vendor/meterless/world-model/reference/src/index.ts`, resolved through the
 * `@meterless/world-model-reference` alias in `next.config.mjs` and
 * `vitest.config.ts`. This shim exists because the reference is compiled with
 * its own tsconfig: our `noUncheckedIndexedAccess` would otherwise report
 * errors inside vendored code we are not allowed to edit.
 *
 * Keep this in step with the reference's public write primitives and read
 * views. Record shapes are imported from the vendored `types.ts`, so they stay
 * exact without re-declaring them.
 */

import type {
  AuditEntry,
  Entity,
  Fact,
  IngestObservation,
  IngestReport,
  MergeProposal,
  Provenance,
  Relationship,
  WorldEvent,
  WorldModelOptions
} from '../../vendor/meterless/world-model/reference/src/types';

export type {
  AuditEntry,
  Entity,
  Fact,
  IngestObservation,
  IngestReport,
  MergeProposal,
  Provenance,
  Relationship,
  WorldEvent,
  WorldModelOptions
};

export interface UpsertEntityInput {
  type: string;
  externalKey?: { system: string; id: string };
  name?: string;
  attrs?: Record<string, unknown>;
  source: Provenance;
  state?: Entity['state'];
}

export interface RelateInput {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  source: Provenance;
}

export interface AssertFactInput {
  about: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  context?: string;
  source: Provenance;
}

export interface GraphView {
  entity(id: string): Entity | undefined;
  neighborsOf(id: string, opts?: { via?: string; inContext?: string; at?: string }): Entity[];
  incoming(id: string, opts?: { via?: string }): Entity[];
  entitiesInContext(contextId: string, opts?: { type?: string }): Entity[];
  traverse(
    startId: string,
    opts: { via: string; direction: 'ancestors' | 'descendants'; maxDepth?: number }
  ): Entity[];
  query(opts: { type?: string; where?: (entity: Entity) => boolean }): Entity[];
}

export interface FactsView {
  about(id: string): Fact[];
}

export class WorldModel {
  constructor(opts: WorldModelOptions);
  upsertEntity(input: UpsertEntityInput): Promise<Entity>;
  upsertContext(input: {
    type: string;
    externalKey?: { system: string; id: string };
    attrs?: Record<string, unknown>;
    parent?: string;
    source: Provenance;
  }): Promise<unknown>;
  relate(input: RelateInput): Promise<Relationship>;
  assertFact(input: AssertFactInput): Promise<Fact>;
  ingest(observations: IngestObservation[]): Promise<IngestReport>;
  view(name: 'graph'): GraphView;
  view(name: 'facts'): FactsView;
  mergeQueue(): readonly MergeProposal[];
  approveMerge(proposalId: string, by: string): Promise<void>;
  rejectMerge(proposalId: string, by: string): Promise<void>;
  audit(): readonly AuditEntry[];
  events(): readonly WorldEvent[];
  stateShape(): unknown;
}

export function entityIdFromName(type: string, name: string): string;
export function externalId(type: string, system: string, id: string): string;
export function normalizeName(name: string): string;
export function nameSimilarity(a: string, b: string): number;
export function canonicalJson(value: unknown): string;
export function decide(
  similarity: number,
  autoMergeAt?: number,
  reviewAt?: number
): 'auto-merge' | 'review' | 'new';
