import { NextResponse } from 'next/server';
import { getStateStore } from '@/src/server/stateStore';
import { resolveSession, withSessionCookie, type RequestSession } from '@/src/server/session';
import { errorResponse } from '@/src/server/http';

/** Audit history across every order, newest event last as stored. */
export async function GET(req: Request) {
  let session: RequestSession | undefined;
  try {
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    await stateStore.ensureInitialized();
    return withSessionCookie(
      NextResponse.json({ events: stateStore.recoveryService.getAuditEvents() }),
      session
    );
  } catch (err) {
    return errorResponse(session, err);
  }
}
