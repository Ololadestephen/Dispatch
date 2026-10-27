import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextResponse } from 'next/server';
import { AppDatabase } from '../../src/persistence/appDb';
import { SESSION_COOKIE_NAME, resolveSession, withSessionCookie } from '../../src/server/session';

/** A request carrying only the cookie header the browser would send. */
function requestWithCookie(cookie?: string): Request {
  return new Request('http://localhost/api/state', {
    headers: cookie ? { cookie } : undefined
  });
}

describe('browser session boundary', () => {
  let appDb: AppDatabase;

  beforeEach(() => {
    appDb = new AppDatabase(':memory:');
  });

  afterEach(() => {
    appDb.db.close();
  });

  it('issues a fresh operator session when no cookie is present', () => {
    const session = resolveSession(requestWithCookie(), appDb);
    expect(session.isNew).toBe(true);
    expect(session.user.role).toBe('operator');
    expect(appDb.findSessionUser(session.sessionId)?.userId).toBe(session.user.userId);
  });

  it('honours a cookie the server issued', () => {
    const created = appDb.createSession();
    const session = resolveSession(
      requestWithCookie(`${SESSION_COOKIE_NAME}=${created.sessionId}`),
      appDb
    );
    expect(session.isNew).toBe(false);
    expect(session.sessionId).toBe(created.sessionId);
    expect(session.user.userId).toBe(created.user.userId);
  });

  it('ignores a forged session id and never adopts it', () => {
    const session = resolveSession(
      requestWithCookie(`${SESSION_COOKIE_NAME}=SES-FORGED-MANAGER`),
      appDb
    );
    expect(session.isNew).toBe(true);
    expect(session.sessionId).not.toBe('SES-FORGED-MANAGER');
    expect(session.user.role).toBe('operator');
  });

  it('degrades to a new session when the cookie encoding is malformed', () => {
    const session = resolveSession(requestWithCookie(`${SESSION_COOKIE_NAME}=%E0%A4%A`), appDb);
    expect(session.isNew).toBe(true);
  });

  it('finds its cookie among unrelated cookies', () => {
    const created = appDb.createSession();
    const session = resolveSession(
      requestWithCookie(`theme=dark; ${SESSION_COOKIE_NAME}=${created.sessionId}; locale=en`),
      appDb
    );
    expect(session.sessionId).toBe(created.sessionId);
  });

  it('sets an httpOnly, same-site cookie only when the session is new', () => {
    const newResponse = withSessionCookie(
      NextResponse.json({ ok: true }),
      resolveSession(requestWithCookie(), appDb)
    );
    const cookie = (newResponse.headers.get('set-cookie') ?? '').toLowerCase();
    expect(cookie).toContain(`${SESSION_COOKIE_NAME.toLowerCase()}=`);
    expect(cookie).toContain('httponly');
    expect(cookie).toContain('samesite=strict');

    const existing = resolveSession(requestWithCookie(), appDb);
    const knownResponse = withSessionCookie(NextResponse.json({ ok: true }), {
      ...existing,
      isNew: false
    });
    expect(knownResponse.headers.get('set-cookie')).toBeNull();
  });
});
