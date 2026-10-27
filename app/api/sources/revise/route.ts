import crypto from 'node:crypto';
import { z } from 'zod';
import { handleMutation } from '@/src/server/http';
import { receiptIdFor } from '@/src/server/deskState';
import { DEMO_ORDER } from '@/src/demo/seedData';
import { MAX_SUPPLIER_TEXT_BYTES } from '@/src/domain/executionLimits';
import { DomainError } from '@/src/domain/errors';

const ReviseSchema = z.strictObject({
  /** Optional only for the original DSP-1042 callers; new callers send the order explicitly. */
  orderId: z.string().min(1).optional(),
  change: z.discriminatedUnion('sourceType', [
    z
      .object({ sourceType: z.literal('inventory'), damaged: z.number().int().nonnegative() })
      .strict(),
    z
      .object({
        sourceType: z.literal('supplier_updates'),
        rawMessageText: z
          .string()
          .trim()
          .min(10)
          .refine(
            (value) => Buffer.byteLength(value, 'utf8') <= MAX_SUPPLIER_TEXT_BYTES,
            'Supplier message is too large.'
          )
      })
      .strict()
  ])
});

/** Writes a new revision of one source record, then re-checks every plan it affects. */
export async function POST(req: Request) {
  return handleMutation(req, { schema: ReviseSchema }, async (body, session, stateStore) => {
    const orderId = body.orderId ?? DEMO_ORDER.orderId;
    const order = await stateStore.sources.readOrderRecord(orderId);
    if (!order) {
      throw new DomainError(
        `Order ${orderId} does not exist in this workspace.`,
        'ORDER_NOT_FOUND'
      );
    }

    const snapshot = await stateStore.sources.fetchEvidenceSnapshot(
      orderId,
      stateStore.clock.nowIso()
    );
    const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    if (body.change.sourceType === 'inventory') {
      await stateStore.sources.writeWarehouse({
        ...snapshot.sources.inventory.data,
        revisionId: `REV-INV-${suffix}`,
        damaged: body.change.damaged
      });

      // A warehouse row is shared by SKU, so every order on that SKU is re-checked.
      const affected = (await stateStore.sources.listOrders()).filter(
        (candidate) => candidate.sku === order.sku
      );
      const invalidatedOrders: string[] = [];
      const changedSources = new Set<string>();
      for (const candidate of affected) {
        const receiptId = receiptIdFor(candidate.orderId);
        if (!stateStore.recoveryService.getReceipt(receiptId)) continue;
        const check = await stateStore.invalidateIfSourcesChanged(receiptId, session.user);
        if (check.invalidated) {
          invalidatedOrders.push(candidate.orderId);
          check.changedSources.forEach((source) => changedSources.add(source));
        }
      }
      return {
        invalidated: invalidatedOrders.length > 0,
        changedSources: [...changedSources],
        invalidatedOrders
      };
    }

    await stateStore.sources.writeSupplierMessage({
      ...snapshot.sources.supplierUpdates.data,
      revisionId: `REV-SUP-${suffix}`,
      rawMessageText: body.change.rawMessageText
    });
    return stateStore.invalidateIfSourcesChanged(receiptIdFor(orderId), session.user);
  });
}
