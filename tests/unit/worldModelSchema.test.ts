import { describe, expect, it } from 'vitest';
import {
  ResolvedSupplierSchema,
  WorldMatchSchema,
  WorldModelReferenceSchema,
  WorldModelStateSchema
} from '../../src/domain/worldModel';

const supplier = {
  canonicalId: 'SUP-1',
  canonicalName: 'Alaba Event Rentals',
  names: ['Alaba Event Rentals'],
  status: 'single' as const,
  sourceRecords: [
    {
      sourceType: 'backup_listings',
      recordId: 'BCK-LST-402',
      name: 'Alaba Event Rentals',
      revisionId: 'REV-BCK-402',
      backingSystem: 'document_store'
    }
  ]
};

const reference = {
  namespace: 'dispatch',
  runId: 'run-1',
  eventId: 'evt-1',
  eventSeq: 0,
  contextEntityId: 'order:DSP-1042',
  resolvedSuppliers: [supplier]
};

describe('World Model receipt references', () => {
  it('accepts a reference without a stored context query (old receipts)', () => {
    expect(WorldModelReferenceSchema.parse(reference)).toEqual(reference);
  });

  it('accepts a bounded context query when present', () => {
    const parsed = WorldModelReferenceSchema.parse({
      ...reference,
      contextQuery: {
        contractId: 'CTR-1',
        subjectEntityId: 'order:DSP-1042',
        relations: ['supplied_by'],
        limit: 10,
        entityIds: ['supplier:SUP-1']
      }
    });
    expect(parsed.contextQuery?.limit).toBe(10);
  });

  it('rejects a non-positive context limit', () => {
    expect(() =>
      WorldModelReferenceSchema.parse({
        ...reference,
        contextQuery: {
          contractId: 'CTR-1',
          subjectEntityId: 'order:DSP-1042',
          relations: [],
          limit: 0,
          entityIds: []
        }
      })
    ).toThrow();
  });

  it('rejects an unknown supplier status', () => {
    expect(() => ResolvedSupplierSchema.parse({ ...supplier, status: 'approved' })).toThrow();
  });

  it('requires a source record to carry its revision', () => {
    expect(() =>
      ResolvedSupplierSchema.parse({
        ...supplier,
        sourceRecords: [{ ...supplier.sourceRecords[0], revisionId: undefined }]
      })
    ).toThrow();
  });
});

describe('World Model review state', () => {
  const match = {
    proposalId: 'MATCH-1',
    leftName: 'Alaba Event Rentals',
    rightName: 'Alaba Events Ltd',
    similarity: 0.8333,
    status: 'pending' as const,
    proposedAt: '2026-10-22T14:00:00.000Z'
  };

  it('accepts a pending match and an optional resolution', () => {
    expect(WorldMatchSchema.parse(match)).toEqual(match);
    expect(
      WorldMatchSchema.parse({
        ...match,
        status: 'approved',
        resolvedAt: '2026-10-22T15:00:00.000Z',
        resolvedBy: 'USR-MANAGER'
      })
    ).toMatchObject({ status: 'approved', resolvedBy: 'USR-MANAGER' });
  });

  it('describes the reference implementation and its storage mode', () => {
    const state = WorldModelStateSchema.parse({
      implementation: 'Meterless World Model (reference implementation)',
      storage: 'local',
      namespace: 'dispatch',
      eventCount: 3,
      entityCount: 4,
      headEventId: 'evt-3',
      headEventSeq: 2,
      pendingMatches: [match],
      recentMatches: [],
      context: null
    });
    expect(state.pendingMatches).toHaveLength(1);
  });

  it('rejects a claim to be a different implementation', () => {
    expect(() =>
      WorldModelStateSchema.parse({
        implementation: 'production library',
        storage: 'local',
        namespace: 'dispatch',
        eventCount: 0,
        entityCount: 0,
        headEventId: 'evt-0',
        headEventSeq: 0,
        pendingMatches: [],
        recentMatches: [],
        context: null
      })
    ).toThrow();
  });
});
