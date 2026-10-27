import { z } from 'zod';
import { handleMutation } from '@/src/server/http';

const CancellationSchema = z.strictObject({
  receiptId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().min(1),
  reason: z.string().trim().min(1).max(240)
});

export async function POST(request: Request) {
  return handleMutation(
    request,
    { schema: CancellationSchema, roles: ['manager'] },
    (body, session, store) => store.recoveryService.cancelPlan({ ...body, actor: session.user })
  );
}
