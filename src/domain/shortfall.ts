import { InconsistentInventoryError } from './errors';

export interface ShortfallCalculationInput {
  requiredQuantity: number;
  usableLocalStock: number;
  eligibleIncomingStock: number;
}

export interface ShortfallCalculationResult {
  requiredQuantity: number;
  usableLocalStock: number;
  eligibleIncomingStock: number;
  totalEligibleSupply: number;
  shortfall: number;
  hasShortage: boolean;
}

/**
 * Deterministically computes the order shortfall.
 */
export function calculateShortfall(input: ShortfallCalculationInput): ShortfallCalculationResult {
  const { requiredQuantity, usableLocalStock, eligibleIncomingStock } = input;

  if (
    !Number.isInteger(requiredQuantity) ||
    !Number.isInteger(usableLocalStock) ||
    !Number.isInteger(eligibleIncomingStock)
  ) {
    throw new InconsistentInventoryError('Quantities for shortfall calculation must be integers');
  }

  if (requiredQuantity < 0 || usableLocalStock < 0 || eligibleIncomingStock < 0) {
    throw new InconsistentInventoryError('Quantities for shortfall calculation cannot be negative');
  }

  const totalEligibleSupply = usableLocalStock + eligibleIncomingStock;
  const shortfall = Math.max(0, requiredQuantity - totalEligibleSupply);

  return {
    requiredQuantity,
    usableLocalStock,
    eligibleIncomingStock,
    totalEligibleSupply,
    shortfall,
    hasShortage: shortfall > 0
  };
}
