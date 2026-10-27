import { z } from 'zod';
import { handleMutation } from '@/src/server/http';

const MergeSchema = z.strictObject({
  proposalId: z.string().min(1),
  decision: z.enum(['approve', 'reject'])
});

/** Approve or reject one review-band supplier identity. Manager only; audited in the workspace. */
export async function POST(req: Request) {
  return handleMutation(
    req,
    { schema: MergeSchema, roles: ['manager'] },
    async (body, session, stateStore) => {
      const match = await stateStore.resolveWorldMatch(
        body.proposalId,
        body.decision,
        session.user
      );
      return { match };
    }
  );
}
