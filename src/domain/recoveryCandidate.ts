import { checkCandidateCompatibility, type InboundEligibilityParams } from './deadline';
import { InvalidDeadlineError } from './errors';
import type { CandidateRemedy } from './receipt';

type CandidateRequirements = Pick<
  InboundEligibilityParams,
  'orderSku' | 'deliveryDeadlineIso' | 'transportBufferMinutes' | 'clock'
> & { requiredQuantity: number };

export interface RecoveryCandidateIssue {
  code: string;
  message: string;
}

/** A listing must cover the shortage and meet the buffered deadline before approval. */
export function getRecoveryCandidateIssue(
  candidate: CandidateRemedy | null | undefined,
  requirements: CandidateRequirements
): RecoveryCandidateIssue | undefined {
  if (requirements.requiredQuantity <= 0) {
    return { code: 'NO_SHORTFALL', message: 'No shortage needs recovery.' };
  }
  if (!candidate) {
    return { code: 'NO_CANDIDATE_REMEDY', message: 'No backup supplier listing.' };
  }
  if (candidate.sku !== requirements.orderSku) {
    return { code: 'CANDIDATE_SKU_MISMATCH', message: 'Backup item does not match the order.' };
  }
  if (candidate.availableQuantity < requirements.requiredQuantity) {
    return {
      code: 'INSUFFICIENT_CANDIDATE_QUANTITY',
      message: `Backup has ${candidate.availableQuantity} of ${requirements.requiredQuantity} chairs needed.`
    };
  }

  // Recompute timing from the actual arrival; a saved eligibility flag is not authority.
  try {
    const timing = checkCandidateCompatibility(
      { sku: candidate.sku, expectedArrivalIso: candidate.statedDeliveryArrivalIso },
      requirements
    );
    if (timing.problem === 'ARRIVES_AFTER_BUFFERED_DEADLINE') {
      return {
        code: 'CANDIDATE_ARRIVES_TOO_LATE',
        message: 'Backup arrives after the transport cutoff.'
      };
    }
    if (timing.problem === 'ARRIVED_IN_PAST') {
      return {
        code: 'CANDIDATE_ARRIVED_IN_PAST',
        message: 'Backup arrival is before the scenario time.'
      };
    }
  } catch (err) {
    if (!(err instanceof InvalidDeadlineError)) throw err;
    return { code: 'CANDIDATE_TIMING_INVALID', message: 'Backup delivery time needs review.' };
  }
  if (!candidate.isEligibleByDeadline) {
    return { code: 'CANDIDATE_TIMING_INVALID', message: 'Backup delivery time needs review.' };
  }
  return undefined;
}
