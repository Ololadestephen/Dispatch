import { NextResponse } from 'next/server';
import { UserSession } from '../domain/policy';
import { AppDatabase } from '../persistence/appDb';

export const SESSION_COOKIE_NAME = 'dispatch_session';

export interface RequestSession {
  sessionId: string;
  user: UserSession;
  isNew: boolean;
}

function readSessionCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const match = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!match) return undefined;
  try {
    return decodeURIComponent(match.slice(SESSION_COOKIE_NAME.length + 1));
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return undefined;
  }
}

/**
 * Resolves the browser's session. Only ids the server issued are honoured; anything else
 * (missing, forged, or from a reset database) gets a fresh operator session.
 */
export function resolveSession(req: Request, appDb: AppDatabase): RequestSession {
  const cookieId = readSessionCookie(req);
  const known = cookieId ? appDb.findSessionUser(cookieId) : undefined;
  if (cookieId && known) {
    return { sessionId: cookieId, user: known, isNew: false };
  }
  const created = appDb.createSession();
  return { sessionId: created.sessionId, user: created.user, isNew: true };
}

export function withSessionCookie<T>(
  response: NextResponse<T>,
  session: RequestSession
): NextResponse<T> {
  if (session.isNew) {
    response.cookies.set(SESSION_COOKIE_NAME, session.sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      path: '/'
    });
  }
  return response;
}
