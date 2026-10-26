import { Clock } from './clock';
import { InvalidDeadlineError } from './errors';

export interface InboundShipment {
  shipmentId: string;
  sku: string;
  quantity: number;
  expectedArrivalIso: string;
  status: 'confirmed' | 'unconfirmed' | 'delayed' | 'cancelled';
  unit?: string;
}

export interface InboundEligibilityParams {
  orderSku: string;
  deliveryDeadlineIso: string;
  transportBufferMinutes: number;
  clock: Clock;
  expectedUnit?: string;
}

export interface InboundEligibilityResult {
  isEligible: boolean;
  eligibleQuantity: number;
  latestEligibleArrivalIso: string;
  ineligibilityReason?:
    | 'UNCONFIRMED_STATUS'
    | 'SKU_MISMATCH'
    | 'UNIT_MISMATCH'
    | 'ARRIVES_AFTER_BUFFERED_DEADLINE'
    | 'ARRIVED_IN_PAST';
}

/**
 * Checks whether an incoming shipment can satisfy a commitment before the buffered deadline.
 */
export function checkInboundEligibility(
  shipment: InboundShipment,
  params: InboundEligibilityParams
): InboundEligibilityResult {
  const deadlineDate = new Date(params.deliveryDeadlineIso);
  if (isNaN(deadlineDate.getTime())) {
    throw new InvalidDeadlineError(`Invalid delivery deadline: ${params.deliveryDeadlineIso}`);
  }

  const arrivalDate = new Date(shipment.expectedArrivalIso);
  if (isNaN(arrivalDate.getTime())) {
    throw new InvalidDeadlineError(
      `Invalid shipment arrival timestamp: ${shipment.expectedArrivalIso}`
    );
  }

  if (params.transportBufferMinutes < 0) {
    throw new InvalidDeadlineError(
      `Transport buffer cannot be negative: ${params.transportBufferMinutes}`
    );
  }

  const latestEligibleArrivalMs =
    deadlineDate.getTime() - params.transportBufferMinutes * 60 * 1000;
  const latestEligibleArrivalDate = new Date(latestEligibleArrivalMs);
  const latestEligibleArrivalIso = latestEligibleArrivalDate.toISOString();

  // 1. Status must be confirmed
  if (shipment.status !== 'confirmed') {
    return {
      isEligible: false,
      eligibleQuantity: 0,
      latestEligibleArrivalIso,
      ineligibilityReason: 'UNCONFIRMED_STATUS'
    };
  }

  const timingReason = findSkuOrTimingProblem(
    shipment,
    params,
    arrivalDate,
    latestEligibleArrivalMs
  );
  if (timingReason) {
    return {
      isEligible: false,
      eligibleQuantity: 0,
      latestEligibleArrivalIso,
      ineligibilityReason: timingReason
    };
  }

  return {
    isEligible: true,
    eligibleQuantity: shipment.quantity,
    latestEligibleArrivalIso
  };
}

export interface CandidateCompatibilityResult {
  isCompatible: boolean;
  latestEligibleArrivalIso: string;
  problem?: Exclude<InboundEligibilityResult['ineligibilityReason'], 'UNCONFIRMED_STATUS'>;
}

/**
 * Checks SKU, unit and buffered-deadline timing for a candidate that is not confirmed
 * (for example a backup listing). It never treats the candidate as confirmed stock.
 */
export function checkCandidateCompatibility(
  candidate: { sku: string; unit?: string; expectedArrivalIso: string },
  params: InboundEligibilityParams
): CandidateCompatibilityResult {
  const deadlineDate = new Date(params.deliveryDeadlineIso);
  if (isNaN(deadlineDate.getTime())) {
    throw new InvalidDeadlineError(`Invalid delivery deadline: ${params.deliveryDeadlineIso}`);
  }
  const arrivalDate = new Date(candidate.expectedArrivalIso);
  if (isNaN(arrivalDate.getTime())) {
    throw new InvalidDeadlineError(
      `Invalid candidate arrival timestamp: ${candidate.expectedArrivalIso}`
    );
  }
  const latestEligibleArrivalMs =
    deadlineDate.getTime() - params.transportBufferMinutes * 60 * 1000;
  const latestEligibleArrivalIso = new Date(latestEligibleArrivalMs).toISOString();
  const problem = findSkuOrTimingProblem(candidate, params, arrivalDate, latestEligibleArrivalMs);
  return { isCompatible: !problem, latestEligibleArrivalIso, problem };
}

function findSkuOrTimingProblem(
  item: { sku: string; unit?: string },
  params: InboundEligibilityParams,
  arrivalDate: Date,
  latestEligibleArrivalMs: number
): CandidateCompatibilityResult['problem'] {
  if (item.sku !== params.orderSku) return 'SKU_MISMATCH';
  if (params.expectedUnit && item.unit && item.unit !== params.expectedUnit) return 'UNIT_MISMATCH';
  if (arrivalDate.getTime() > latestEligibleArrivalMs) return 'ARRIVES_AFTER_BUFFERED_DEADLINE';
  if (arrivalDate.getTime() < params.clock.now().getTime()) return 'ARRIVED_IN_PAST';
  return undefined;
}
