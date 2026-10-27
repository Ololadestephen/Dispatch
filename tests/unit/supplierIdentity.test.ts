import { describe, expect, it } from 'vitest';
import { supplierMatchesPlan } from '../../src/domain/supplierIdentity';
import type { DecisionReceipt } from '../../src/domain/receipt';
import type { ResolvedSupplier } from '../../src/domain/worldModel';

const supplier = (overrides: Partial<ResolvedSupplier> = {}): ResolvedSupplier => ({
  canonicalId: 'SUP-1',
  canonicalName: 'Alaba Event Rentals',
  names: ['Alaba Event Rentals', 'Alaba Events Ltd'],
  status: 'merged',
  sourceRecords: [
    {
      sourceType: 'backup_listings',
      recordId: 'BCK-LST-402',
      name: 'Alaba Event Rentals',
      revisionId: 'REV-BCK-402',
      backingSystem: 'document_store'
    }
  ],
  ...overrides
});

const receipt = (worldModel?: DecisionReceipt['worldModel']): DecisionReceipt =>
  ({
    candidateRemedy: {
      listingId: 'BCK-LST-402',
      revisionId: 'REV-BCK-402',
      supplierName: 'Alaba Event Rentals',
      sku: 'CHR-GOLD-CHIAVARI',
      availableQuantity: 60,
      statedDeliveryArrivalIso: '2026-10-24T07:00:00+01:00',
      costKobo: 9_000_000,
      isConfirmedReservation: false,
      isEligibleByDeadline: true
    },
    worldModel
  }) as unknown as DecisionReceipt;

const reference = (suppliers: ResolvedSupplier[]): NonNullable<DecisionReceipt['worldModel']> => ({
  namespace: 'dispatch',
  runId: 'run-1',
  eventId: 'evt-1',
  eventSeq: 1,
  contextEntityId: 'order:DSP-1042',
  resolvedSuppliers: suppliers
});

describe('supplier identity at confirmation', () => {
  it('accepts the receipt candidate name', () => {
    expect(supplierMatchesPlan(receipt(), 'Alaba Event Rentals')).toBe(true);
  });

  it('rejects a receipt with no candidate remedy', () => {
    expect(
      supplierMatchesPlan({ ...receipt(), candidateRemedy: null } as DecisionReceipt, 'Alaba')
    ).toBe(false);
  });

  it('accepts an alias approved into the same merged identity group', () => {
    expect(supplierMatchesPlan(receipt(reference([supplier()])), 'Alaba Events Ltd')).toBe(true);
  });

  it('rejects an alias when the group is still pending review', () => {
    expect(
      supplierMatchesPlan(
        receipt(reference([supplier({ status: 'pending_review' })])),
        'Alaba Events Ltd'
      )
    ).toBe(false);
  });

  it('rejects a merged alias that does not cite this exact backup lot', () => {
    expect(
      supplierMatchesPlan(
        receipt(
          reference([
            supplier({
              sourceRecords: [
                {
                  sourceType: 'backup_listings',
                  recordId: 'BCK-LST-999',
                  name: 'Alaba Event Rentals',
                  revisionId: 'REV-BCK-402',
                  backingSystem: 'document_store'
                }
              ]
            })
          ])
        ),
        'Alaba Events Ltd'
      )
    ).toBe(false);
  });

  it('rejects a merged alias from a different revision of the lot', () => {
    expect(
      supplierMatchesPlan(
        receipt(
          reference([
            supplier({
              sourceRecords: [
                {
                  sourceType: 'backup_listings',
                  recordId: 'BCK-LST-402',
                  name: 'Alaba Event Rentals',
                  revisionId: 'REV-OLD',
                  backingSystem: 'document_store'
                }
              ]
            })
          ])
        ),
        'Alaba Events Ltd'
      )
    ).toBe(false);
  });

  it('rejects an unrelated supplier name', () => {
    expect(supplierMatchesPlan(receipt(reference([supplier()])), 'Other Supplier')).toBe(false);
  });
});
