import { z } from 'zod';
import { handleMutation } from '@/src/server/http';

const ResetSchema = z.strictObject({ confirmReset: z.literal(true) });

/** Restores the synthetic demo baseline. Manager only. */
export async function POST(req: Request) {
  return handleMutation(
    req,
    { schema: ResetSchema, roles: ['manager'] },
    async (_body, _session, stateStore) => {
      await stateStore.resetDemo();
      return {};
    }
  );
}
