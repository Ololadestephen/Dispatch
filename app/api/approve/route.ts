import { z } from 'zod';
import { handleMutation } from '@/src/server/http';
import { DomainError } from '@/src/domain/errors';

const ApproveSchema = z.strictObject({
  receiptId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(128)
});

export async function POST(req: Request) {
  return handleMutation(
    req,
    { schema: ApproveSchema, roles: ['manager', 'operator'] },
    async (body, session, stateStore) => {
      const { invalidated, changedSources } = await stateStore.invalidateIfSourcesChanged(
        body.receiptId,
        session.user
      );
      if (invalidated) {
        throw new DomainError(
          `Source changed. Review this plan again. (${changedSources.join('; ')})`,
          'PLAN_STALE'
        );
      }
      return stateStore.recoveryService.approvePlan({ ...body, actor: session.user });
    }
  );
}
