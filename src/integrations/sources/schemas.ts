import { z } from 'zod';
import { DomainError } from '../../domain/errors';

const id = z.string().min(1);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const revision = { revisionId: id, isDemo: z.literal(true) };

export const OrderSourceSchema = z.strictObject({
  ...revision,
  orderId: id,
  customerName: id,
  eventName: id,
  deliveryLocation: id,
  deliveryDeadlineIso: timestamp,
  sku: id,
  itemDescription: id,
  requiredQuantity: quantity,
  operationalStatus: z.enum(['confirmed', 'at_risk', 'recovery_confirmed', 'delivered'])
});
export const InventorySourceSchema = z.strictObject({
  ...revision,
  warehouseId: id,
  sku: id,
  physicallyPresent: quantity,
  damaged: quantity,
  activeAllocations: quantity,
  lastAuditedIso: timestamp
});
export const InboundSourceSchema = z.strictObject({
  ...revision,
  shipmentId: id,
  orderId: id,
  supplierName: id,
  sku: id,
  originallyExpectedQuantity: quantity,
  originalPromisedArrivalIso: timestamp,
  status: z.enum(['scheduled', 'cancelled'])
});
export const SupplierSourceSchema = z.strictObject({
  ...revision,
  messageId: id,
  orderId: id,
  supplierName: id,
  rawMessageText: z.string(),
  receivedAtIso: timestamp
});
export const BackupSourceSchema = z.strictObject({
  ...revision,
  listingId: id,
  supplierName: id,
  sku: id,
  availableQuantity: quantity,
  statedDeliveryArrivalIso: timestamp,
  costKobo: quantity,
  isConfirmedReservation: z.literal(false),
  listedAtIso: timestamp
});

/** Reject external record shapes before they become trusted evidence. */
export function parseSourceRecord<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        if (path) return path;
        return issue.code === 'unrecognized_keys' ? issue.keys.join(', ') : 'record';
      })
      .join(', ');
    throw new DomainError(`${label} has invalid source fields: ${fields}.`, 'SOURCE_UNAVAILABLE');
  }
  return result.data;
}

/** No coercion of empty strings, fractions, negatives or unsafe integer values. */
export function sourceInteger(value: unknown, label: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new DomainError(`${label} is not a nonnegative whole number.`, 'SOURCE_UNAVAILABLE');
  }
  return Number(value);
}
