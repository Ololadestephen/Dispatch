import { NextResponse } from 'next/server';
import { getStateStore } from '@/src/server/stateStore';
import { listOrderSummaries } from '@/src/server/deskState';
import { resolveSession, withSessionCookie, type RequestSession } from '@/src/server/session';
import { errorResponse } from '@/src/server/http';

/** Every order in the workspace, with the latest receipt status for each. */
export async function GET(req: Request) {
  let session: RequestSession | undefined;
  try {
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    await stateStore.ensureInitialized();
    const orders = await listOrderSummaries(stateStore);
    return withSessionCookie(NextResponse.json({ orders }), session);
  } catch (err) {
    return errorResponse(session, err);
  }
}
