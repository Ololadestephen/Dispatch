import { NextResponse } from 'next/server';
import { getStateStore } from '@/src/server/stateStore';
import { buildOrderState } from '@/src/server/deskState';
import { resolveSession, withSessionCookie, type RequestSession } from '@/src/server/session';
import { errorResponse } from '@/src/server/http';
import { DEMO_ORDER } from '@/src/demo/seedData';

/** Backward-compatible alias for the original desk: DSP-1042's state. */
export async function GET(req: Request) {
  let session: RequestSession | undefined;
  try {
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    await stateStore.ensureInitialized();
    const state = await buildOrderState(stateStore, DEMO_ORDER.orderId, session.user);
    return withSessionCookie(NextResponse.json(state), session);
  } catch (err) {
    return errorResponse(session, err);
  }
}
