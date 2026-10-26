import { z } from 'zod';
import { handleMutation } from '@/src/server/http';

const InvestigateSchema = z.strictObject({ orderId: z.string().min(1) });

export async function POST(req: Request) {
  return handleMutation(req, { schema: InvestigateSchema }, async (body, session, stateStore) => {
    const result = await stateStore.investigationService.investigateOrder(
      body.orderId,
      session.user,
      { signal: req.signal }
    );
    return { receipt: result.receipt, modelMetrics: result.modelMetrics };
  });
}
