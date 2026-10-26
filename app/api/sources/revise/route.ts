import crypto from 'node:crypto';
import { z } from 'zod';
import { DEMO_RECEIPT_ID } from '@/src/server/stateStore';
import { handleMutation } from '@/src/server/http';
import { DEMO_ORDER } from '@/src/demo/seedData';
import { MAX_SUPPLIER_TEXT_BYTES } from '@/src/domain/executionLimits';

const ReviseSchema = z.strictObject({
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

/** Writes a new revision of one source record, then re-checks the active plan against it. */
export async function POST(req: Request) {
  return handleMutation(req, { schema: ReviseSchema }, async ({ change }, session, stateStore) => {
    const snapshot = await stateStore.sources.fetchEvidenceSnapshot(
      DEMO_ORDER.orderId,
      stateStore.clock.nowIso()
    );
    const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
    if (change.sourceType === 'inventory') {
      await stateStore.sources.writeWarehouse({
        ...snapshot.sources.inventory.data,
        revisionId: `REV-INV-${suffix}`,
        damaged: change.damaged
      });
    } else {
      await stateStore.sources.writeSupplierMessage({
        ...snapshot.sources.supplierUpdates.data,
        revisionId: `REV-SUP-${suffix}`,
        rawMessageText: change.rawMessageText
      });
    }
    return stateStore.invalidateIfSourcesChanged(DEMO_RECEIPT_ID, session.user);
  });
}
