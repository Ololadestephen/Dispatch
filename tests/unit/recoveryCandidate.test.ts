import { describe, expect, it } from 'vitest';
import {
  getBackupAvailabilityIssue,
  getRecoveryCandidateIssue
} from '../../src/domain/recoveryCandidate';
import type { CandidateRemedy } from '../../src/domain/receipt';
import type { BackupAvailability } from '../../src/domain/reservation';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../../src/domain/clock';

const clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);

const candidate = (overrides: Partial<CandidateRemedy> = {}): CandidateRemedy => ({
  listingId: 'BCK-LST-402',
  revisionId: 'REV-BCK-402',
  supplierName: 'Lagos Event Hire',
  sku: 'CHR-GOLD-CHIAVARI',
  availableQuantity: 60,
  statedDeliveryArrivalIso: '2026-10-24T07:00:00+01:00',
  costKobo: 9_000_000,
  isConfirmedReservation: false,
  isEligibleByDeadline: true,
  ...overrides
});

const requirements = {
  orderSku: 'CHR-GOLD-CHIAVARI',
  deliveryDeadlineIso: '2026-10-24T09:00:00+01:00',
  transportBufferMinutes: 60,
  clock,
  shortfallQuantity: 60
};

describe('deterministic recovery candidate checks', () => {
  it('reports no recovery need when there is no shortfall', () => {
    expect(
      getRecoveryCandidateIssue(candidate(), { ...requirements, shortfallQuantity: 0 })
    ).toEqual({ code: 'NO_SHORTFALL', message: 'No shortage needs recovery.' });
  });

  it('reports a missing candidate', () => {
    expect(getRecoveryCandidateIssue(undefined, requirements)).toMatchObject({
      code: 'NO_CANDIDATE_REMEDY'
    });
  });

  it('rejects a candidate for another SKU', () => {
    expect(
      getRecoveryCandidateIssue(candidate({ sku: 'TBL-ROUND-72' }), requirements)
    ).toMatchObject({ code: 'CANDIDATE_SKU_MISMATCH' });
  });

  it('names the missing quantity in catalogue units', () => {
    expect(
      getRecoveryCandidateIssue(candidate({ availableQuantity: 20 }), requirements)
    ).toMatchObject({
      code: 'INSUFFICIENT_CANDIDATE_QUANTITY',
      message: 'Backup has 20 of 60 chairs needed.'
    });
  });

  it('rejects an arrival after the buffered deadline', () => {
    expect(
      getRecoveryCandidateIssue(
        candidate({ statedDeliveryArrivalIso: '2026-10-24T08:30:00+01:00' }),
        requirements
      )
    ).toMatchObject({ code: 'CANDIDATE_ARRIVES_TOO_LATE' });
  });

  it('rejects an arrival before the scenario clock', () => {
    expect(
      getRecoveryCandidateIssue(
        candidate({ statedDeliveryArrivalIso: '2026-10-20T07:00:00+01:00' }),
        requirements
      )
    ).toMatchObject({ code: 'CANDIDATE_ARRIVED_IN_PAST' });
  });

  it('turns an invalid deadline into a reviewable timing issue', () => {
    expect(
      getRecoveryCandidateIssue(candidate(), { ...requirements, deliveryDeadlineIso: 'bad-date' })
    ).toMatchObject({ code: 'CANDIDATE_TIMING_INVALID' });
  });

  it('does not trust a saved eligibility flag when timing is invalid', () => {
    expect(
      getRecoveryCandidateIssue(
        candidate({
          isEligibleByDeadline: false,
          statedDeliveryArrivalIso: '2026-10-24T07:00:00+01:00'
        }),
        requirements
      )
    ).toMatchObject({ code: 'CANDIDATE_TIMING_INVALID' });
  });

  it('accepts a candidate that covers the shortfall inside the buffer', () => {
    expect(getRecoveryCandidateIssue(candidate(), requirements)).toBeUndefined();
  });
});

describe('live backup availability checks', () => {
  const availability = (overrides: Partial<BackupAvailability> = {}): BackupAvailability => ({
    listingId: 'BCK-LST-402',
    advertisedQuantity: 60,
    reservedQuantity: 0,
    availableQuantity: 60,
    reservations: [],
    ...overrides
  });

  it('passes when the lot still covers the shortfall or has no live reading', () => {
    expect(getBackupAvailabilityIssue(availability(), 60)).toBeUndefined();
    expect(getBackupAvailabilityIssue(undefined, 60)).toBeUndefined();
  });

  it('names the holding orders when stock is taken', () => {
    expect(
      getBackupAvailabilityIssue(
        availability({
          availableQuantity: 0,
          reservedQuantity: 60,
          reservations: [
            {
              reservationId: 'RES-1',
              backupListingId: 'BCK-LST-402',
              backupRevisionId: 'REV-BCK-402',
              sku: 'CHR-GOLD-CHIAVARI',
              orderId: 'DSP-1042',
              receiptId: 'RCP-DSP-1042-01',
              receiptVersion: 2,
              quantity: 60,
              createdAtIso: '2026-10-22T14:00:00.000Z'
            },
            {
              reservationId: 'RES-2',
              backupListingId: 'BCK-LST-402',
              backupRevisionId: 'REV-BCK-402',
              sku: 'CHR-GOLD-CHIAVARI',
              orderId: 'DSP-1042',
              receiptId: 'RCP-DSP-1042-01',
              receiptVersion: 2,
              quantity: 1,
              createdAtIso: '2026-10-22T14:00:00.000Z'
            }
          ]
        }),
        60
      )
    ).toEqual({ code: 'BACKUP_STOCK_TAKEN', message: 'Backup stock taken by DSP-1042 — re-plan.' });
  });

  it('reports the remaining quantity when no order holds the lot', () => {
    expect(getBackupAvailabilityIssue(availability({ availableQuantity: 20 }), 60)).toEqual({
      code: 'BACKUP_STOCK_TAKEN',
      message: 'Only 20 of 60 backup units remain.'
    });
  });
});
