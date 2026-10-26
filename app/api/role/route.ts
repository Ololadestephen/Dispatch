import { z } from 'zod';
import { handleMutation } from '@/src/server/http';

const RoleSchema = z.strictObject({ role: z.enum(['operator', 'manager']) });

/** Demo role switcher: changes the role of this browser's session only. */
export async function POST(req: Request) {
  return handleMutation(req, { schema: RoleSchema }, (body, session, stateStore) => ({
    currentUser: stateStore.appDb.setSessionRole(session.sessionId, body.role)
  }));
}
