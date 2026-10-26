import crypto from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../domain/errors';

/**
 * Client for a Zetaris platform (local Docker install of the hackathon bundle).
 * Uses the same routes as Zetaris's own helper (github.com/zetaris/getting-started,
 * scripts/zetaris_api.ts): POST /api/auth/login, then
 * POST /api/proxy/sql-editor/sqls/run-query with Bearer token, X-Org-ID and X-Request-ID.
 * Provider failures are SOURCE_UNAVAILABLE errors; caller cancellation propagates.
 * Nothing falls back to local files.
 */

export interface ZetarisConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

const LoginResponse = z.object({ idToken: z.string().min(1), orgId: z.number().int() });
const QueryResponse = z.object({
  headers: z.array(z.string()),
  data: z.array(z.array(z.string().nullable())),
  total: z.number().optional(),
  timeUsed: z.number().optional()
});

export interface ZetarisQueryResult {
  rows: Array<Record<string, string | null>>;
  timeUsedMs?: number;
}

export function zetarisConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): ZetarisConfig | undefined {
  const { ZETARIS_BASE_URL, ZETARIS_USERNAME, ZETARIS_PASSWORD } = env;
  if (!ZETARIS_BASE_URL || !ZETARIS_USERNAME || !ZETARIS_PASSWORD) return undefined;
  return {
    baseUrl: ZETARIS_BASE_URL.replace(/\/$/, ''),
    username: ZETARIS_USERNAME,
    password: ZETARIS_PASSWORD
  };
}

/** Quotes a value as a SQL string literal. Callers also validate identifiers they interpolate. */
export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export class ZetarisClient {
  private session: { token: string; orgId: number } | undefined;

  constructor(private readonly config: ZetarisConfig) {}

  async query(sql: string, limit = 1000, signal?: AbortSignal): Promise<ZetarisQueryResult> {
    signal?.throwIfAborted();
    const session = await this.login(signal);
    let res = await this.post(
      '/api/proxy/sql-editor/sqls/run-query',
      { sql, limit },
      session,
      signal
    );
    if (res.status === 401) {
      this.session = undefined;
      res = await this.post(
        '/api/proxy/sql-editor/sqls/run-query',
        { sql, limit },
        await this.login(signal),
        signal
      );
    }
    const body: unknown = await res.json().catch(() => null);
    signal?.throwIfAborted();
    if (!res.ok) {
      const errorBody = z.object({ msg: z.string() }).safeParse(body);
      const msg = errorBody.success ? errorBody.data.msg : `HTTP ${res.status}`;
      throw new DomainError(`Zetaris query failed: ${msg.slice(0, 300)}`, 'SOURCE_UNAVAILABLE');
    }
    const parsed = QueryResponse.safeParse(body);
    if (!parsed.success) {
      throw new DomainError('Zetaris returned an unexpected query response.', 'SOURCE_UNAVAILABLE');
    }
    const { headers, data, timeUsed } = parsed.data;
    return {
      rows: data.map((row) => Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null]))),
      timeUsedMs: timeUsed
    };
  }

  private async login(signal?: AbortSignal): Promise<{ token: string; orgId: number }> {
    if (this.session) return this.session;
    const res = await this.post(
      '/api/auth/login',
      {
        username: this.config.username,
        password: this.config.password
      },
      undefined,
      signal
    );
    const parsed = LoginResponse.safeParse(await res.json().catch(() => null));
    signal?.throwIfAborted();
    if (!res.ok || !parsed.success) {
      throw new DomainError(`Zetaris sign-in failed (HTTP ${res.status}).`, 'SOURCE_UNAVAILABLE');
    }
    this.session = { token: parsed.data.idToken, orgId: parsed.data.orgId };
    return this.session;
  }

  private async post(
    path: string,
    body: unknown,
    session?: { token: string; orgId: number },
    signal?: AbortSignal
  ): Promise<Response> {
    try {
      signal?.throwIfAborted();
      return await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': crypto.randomUUID(),
          ...(session
            ? { Authorization: `Bearer ${session.token}`, 'X-Org-ID': String(session.orgId) }
            : {})
        },
        body: JSON.stringify(body),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs ?? 30_000)])
          : AbortSignal.timeout(this.config.timeoutMs ?? 30_000)
      });
    } catch (err) {
      signal?.throwIfAborted();
      throw new DomainError(
        `Cannot reach Zetaris at ${this.config.baseUrl}: ${(err as Error).message}`,
        'SOURCE_UNAVAILABLE'
      );
    }
  }
}
