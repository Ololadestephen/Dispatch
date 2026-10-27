import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorResponse, handleMutation } from '../../src/server/http';
import { DomainError } from '../../src/domain/errors';
import { SEEDED_USERS } from '../../src/demo/seedData';
import type { RequestSession } from '../../src/server/session';

const session = (overrides: Partial<RequestSession> = {}): RequestSession => ({
  sessionId: 'SES-TEST-1',
  user: SEEDED_USERS.operator,
  isNew: true,
  ...overrides
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HTTP error mapping', () => {
  const cases: Array<[string, number]> = [
    ['INVALID_REQUEST', 400],
    ['FORBIDDEN_ROLE', 403],
    ['UNAUTHORIZED_APPROVAL', 403],
    ['RECEIPT_NOT_FOUND', 404],
    ['ORDER_NOT_FOUND', 404],
    ['VERSION_CONFLICT', 409],
    ['INVALID_STATE_TRANSITION', 409],
    ['PLAN_STALE', 409],
    ['BACKUP_STOCK_TAKEN', 409],
    ['SOURCE_UNAVAILABLE', 503],
    ['MODEL_OUTAGE', 503],
    ['MODEL_BUDGET_EXCEEDED', 429],
    ['WORKFLOW_TIMEOUT', 504],
    ['REQUEST_CANCELLED', 408]
  ];

  it.each(cases)('maps %s to %i and keeps the domain message', async (code, status) => {
    const response = errorResponse(undefined, new DomainError(`boom ${code}`, code));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: `boom ${code}`,
      code
    });
  });

  it('maps an unrecognised domain code to 422 rather than 500', async () => {
    const response = errorResponse(undefined, new DomainError('odd', 'SOMETHING_NEW'));
    expect(response.status).toBe(422);
  });

  it('hides an unexpected error behind a generic 500 and logs it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = errorResponse(undefined, new Error('SQLITE_CORRUPT: secret path'));
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.error).not.toContain('SQLITE_CORRUPT');
    expect(body.error).toBe('Unexpected server error. Refresh to check the current state.');
    expect(logged).toHaveBeenCalledOnce();
  });

  it('sets the session cookie only for a newly created session', () => {
    const fresh = errorResponse(session(), new DomainError('x', 'INVALID_REQUEST'));
    expect(fresh.headers.get('set-cookie')).toContain('dispatch_session=SES-TEST-1');
    const known = errorResponse(session({ isNew: false }), new DomainError('x', 'INVALID_REQUEST'));
    expect(known.headers.get('set-cookie')).toBeNull();
  });
});

describe('mutation envelope', () => {
  const schema = z.strictObject({ note: z.string().min(1) });

  it('rejects a body that is not JSON before running the handler', async () => {
    const handler = vi.fn(async () => ({ ok: true }));
    const response = await handleMutation(
      new Request('http://localhost/api/test', {
        method: 'POST',
        body: '{nope',
        headers: { 'content-type': 'application/json' }
      }),
      { schema },
      handler
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_REQUEST',
      error: 'Request body must be valid JSON.'
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('reports the failing field for a schema violation', async () => {
    const response = await handleMutation(
      new Request('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify({ note: 4, extra: true }),
        headers: { 'content-type': 'application/json' }
      }),
      { schema },
      async () => ({ ok: true })
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('note');
  });

  it('blocks a role the route does not allow', async () => {
    const response = await handleMutation(
      new Request('http://localhost/api/test', {
        method: 'POST',
        body: JSON.stringify({ note: 'hello' }),
        headers: { 'content-type': 'application/json' }
      }),
      { schema, roles: ['manager'] },
      async () => ({ ok: true })
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'FORBIDDEN_ROLE',
      error: 'This action needs the manager role.'
    });
  });
});
