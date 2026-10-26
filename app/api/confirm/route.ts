import { z } from 'zod';
import { handleMutation } from '@/src/server/http';
import { DomainError } from '@/src/domain/errors';

const ConfirmSchema = z.strictObject({
  receiptId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(128),
  supplierName: z.string().min(1),
  sku: z.string().min(1),
  confirmedQuantity: z.number().int().positive(),
  confirmedArrivalIso: z.iso.datetime({ offset: true }),
  confirmationReference: z.string().min(1),
  evidenceExcerpt: z.string().trim().min(10)
});

export async function POST(req: Request) {
  return handleMutation(
    req,
    { schema: ConfirmSchema, roles: ['operator', 'manager'] },
    async (body, session, stateStore) => {
      const { receiptId, expectedVersion, idempotencyKey, ...confirmation } = body;
      const { invalidated, changedSources } = await stateStore.invalidateIfSourcesChanged(
        receiptId,
        session.user
      );
      if (invalidated) {
        throw new DomainError(
          `Source changed. Review this plan again. (${changedSources.join('; ')})`,
          'PLAN_STALE'
        );
      }
      return stateStore.recoveryService.recordSupplierConfirmation({
        receiptId,
        expectedVersion,
        idempotencyKey,
        actor: session.user,
        confirmation
      });
    }
  );
}
