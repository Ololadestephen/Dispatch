import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DomainError } from '../domain/errors';
import { UserRole } from '../domain/policy';
import { RequestSession, resolveSession, withSessionCookie } from './session';
import { getStateStore, type StateStore } from './stateStore';

const STATUS_BY_CODE: Record<string, number> = {
  INVALID_REQUEST: 400,
  FORBIDDEN_ROLE: 403,
  UNAUTHORIZED_APPROVAL: 403,
  RECEIPT_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  VERSION_CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  PLAN_STALE: 409,
  BACKUP_STOCK_TAKEN: 409,
  SOURCE_UNAVAILABLE: 503,
  MODEL_OUTAGE: 503,
  MODEL_BUDGET_EXCEEDED: 429,
  WORKFLOW_TIMEOUT: 504,
  REQUEST_CANCELLED: 408
};

export function errorResponse(session: RequestSession | undefined, err: unknown): NextResponse {
  const code = err instanceof DomainError ? err.code : 'INTERNAL_ERROR';
  const status = STATUS_BY_CODE[code] ?? (err instanceof DomainError ? 422 : 500);
  const message =
    err instanceof DomainError
      ? err.message
      : 'Unexpected server error. Refresh to check the current state.';
  if (!(err instanceof DomainError)) console.error(err);
  const response = NextResponse.json({ success: false, error: message, code }, { status });
  return session ? withSessionCookie(response, session) : response;
}

function invalid(session: RequestSession, message: string): NextResponse {
  return withSessionCookie(
    NextResponse.json({ success: false, error: message, code: 'INVALID_REQUEST' }, { status: 400 }),
    session
  );
}

/**
 * Runs a mutating route: resolves the session, enforces the role, strictly parses the JSON body
 * (schemas are z.strictObject: no defaults, unknown keys rejected) and maps domain errors to HTTP statuses.
 */
export async function handleMutation<S extends z.ZodObject>(
  req: Request,
  options: { schema: S; roles?: UserRole[] },
  handler: (
    body: z.infer<S>,
    session: RequestSession,
    stateStore: StateStore
  ) => Promise<object> | object
): Promise<NextResponse> {
  let session: RequestSession | undefined;
  try {
    const stateStore = getStateStore();
    session = resolveSession(req, stateStore.appDb);
    if (options.roles && !options.roles.includes(session.user.role)) {
      return withSessionCookie(
        NextResponse.json(
          {
            success: false,
            error: `This action needs the ${options.roles.join(' or ')} role.`,
            code: 'FORBIDDEN_ROLE'
          },
          { status: 403 }
        ),
        session
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return invalid(session, 'Request body must be valid JSON.');
    }
    const parsed = options.schema.safeParse(raw);
    if (!parsed.success) {
      return invalid(
        session,
        parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
      );
    }
    await stateStore.ensureInitialized();
    const result = await handler(parsed.data, session, stateStore);
    return withSessionCookie(NextResponse.json({ success: true, ...result }), session);
  } catch (err) {
    return errorResponse(session, err);
  }
}
