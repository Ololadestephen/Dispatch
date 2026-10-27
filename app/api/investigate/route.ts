import { z } from 'zod';
import { handleMutation } from '@/src/server/http';
import { DomainError } from '@/src/domain/errors';

const InvestigateSchema = z.strictObject({ orderId: z.string().min(1) });

export async function POST(req: Request) {
  return handleMutation(req, { schema: InvestigateSchema }, async (body, session, stateStore) => {
    const order = await stateStore.sources.readOrderRecord(body.orderId);
    if (!order) {
      throw new DomainError(
        `Order ${body.orderId} does not exist in this workspace.`,
        'ORDER_NOT_FOUND'
      );
    }
    const result = await stateStore.investigationService.investigateOrder(
      body.orderId,
      session.user,
      { signal: req.signal }
    );
    return { receipt: result.receipt, modelMetrics: result.modelMetrics };
  });
}
