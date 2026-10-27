import { NextResponse } from 'next/server';
import { getStateStore } from '@/src/server/stateStore';
import { buildOrderState } from '@/src/server/deskState';
import { resolveSession, withSessionCookie, type RequestSession } from '@/src/server/session';
import { errorResponse } from '@/src/server/http';

/** Everything the desk renders for one order. Unknown order ids are a real 404. */
export async function GET(req: Request, context: { params: Promise<{ orderId: string }> }) {
  let session: RequestSession | undefined;
  try {
    const { orderId } = await context.params;
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    await stateStore.ensureInitialized();
    const state = await buildOrderState(stateStore, orderId, session.user);
    return withSessionCookie(NextResponse.json(state), session);
  } catch (err) {
    return errorResponse(session, err);
  }
}
