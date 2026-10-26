import { InconsistentInventoryError } from './errors';

export interface WarehouseStockInput {
  sku: string;
  physicallyPresent: number;
  damaged: number;
  activeAllocations: number;
}

export interface UsableStockResult {
  sku: string;
  physicallyPresent: number;
  damaged: number;
  activeAllocations: number;
  usableAvailable: number;
}

/**
 * Calculates usable, unallocated stock.
 *
 * Rules:
 * - physicallyPresent, damaged, and activeAllocations must be non-negative integers.
 * - damaged + activeAllocations cannot exceed physicallyPresent.
 * - Inconsistent inputs throw InconsistentInventoryError rather than clamping.
 */
export function calculateUsableStock(input: WarehouseStockInput): UsableStockResult {
  const { sku, physicallyPresent, damaged, activeAllocations } = input;

  if (
    !Number.isInteger(physicallyPresent) ||
    !Number.isInteger(damaged) ||
    !Number.isInteger(activeAllocations)
  ) {
    throw new InconsistentInventoryError(
      `Stock values must be integers. Received: present=${physicallyPresent}, damaged=${damaged}, allocated=${activeAllocations}`
    );
  }

  if (physicallyPresent < 0 || damaged < 0 || activeAllocations < 0) {
    throw new InconsistentInventoryError(
      `Stock values cannot be negative. Received: present=${physicallyPresent}, damaged=${damaged}, allocated=${activeAllocations}`
    );
  }

  if (damaged + activeAllocations > physicallyPresent) {
    throw new InconsistentInventoryError(
      `Damaged (${damaged}) plus allocated (${activeAllocations}) exceeds physically present (${physicallyPresent}) for SKU ${sku}`
    );
  }

  const usableAvailable = physicallyPresent - damaged - activeAllocations;

  return {
    sku,
    physicallyPresent,
    damaged,
    activeAllocations,
    usableAvailable
  };
}
