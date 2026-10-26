import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NvidiaExtractionAgent,
  TEST_MOCK_SUPPLIER_EXTRACTION
} from '../../src/integrations/nvidia/extractionAgent';
import { ZetarisClient } from '../../src/integrations/zetaris/client';
import { DEMO_SUPPLIER_MESSAGE } from '../../src/demo/seedData';
import { ModelOutageError } from '../../src/domain/errors';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Provider HTTP contracts (mocked transport, no provider calls)', () => {
  it('verifies the NVIDIA request and decodes grounded provider output', async () => {
    const fetch = vi.fn().mockResolvedValue(
      reply({
        choices: [{ message: { content: JSON.stringify(TEST_MOCK_SUPPLIER_EXTRACTION) } }],
        usage: { prompt_tokens: 400, completion_tokens: 100, total_tokens: 500 }
      })
    );
    vi.stubGlobal('fetch', fetch);
    const agent = new NvidiaExtractionAgent({
      apiKey: 'nvapi-synthetic-test-key',
      model: 'test-model'
    });
    const result = await agent.extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(request.headers.Authorization).toBe('Bearer nvapi-synthetic-test-key');
    expect(JSON.parse(request.body)).toMatchObject({
      model: 'test-model',
      temperature: 0,
      max_tokens: 1024
    });
    expect(result.extraction.delayedQuantity).toBe(60);
    expect(result.metrics.totalTokens).toBe(500);
    expect(result.resolvedQuotes[0]?.text).toContain('Monday 26 Oct');
  });

  it('classifies a schema-invalid model response as a model outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(reply({ choices: [{ message: { content: '{}' } }] }))
    );
    const agent = new NvidiaExtractionAgent({ apiKey: 'nvapi-synthetic-test-key' });
    await expect(
      agent.extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText)
    ).rejects.toThrow(ModelOutageError);
  });

  it('keeps the NVIDIA timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, request: RequestInit) => {
        signal = request.signal as AbortSignal;
        return {
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              signal!.addEventListener('abort', () => reject(new Error('Body read aborted')), {
                once: true
              });
            })
        };
      })
    );
    const agent = new NvidiaExtractionAgent({ apiKey: 'nvapi-synthetic-test-key', timeoutMs: 20 });
    const rejection = expect(
      agent.extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText)
    ).rejects.toThrow(ModelOutageError);
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(signal?.aborted).toBe(true);
  }, 500);

  it('authenticates, refreshes an expired Zetaris token, and decodes rows', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply({ idToken: 'test-token-one', orgId: 7 }))
      .mockResolvedValueOnce(reply({ msg: 'Expired' }, 401))
      .mockResolvedValueOnce(reply({ idToken: 'test-token-two', orgId: 7 }))
      .mockResolvedValueOnce(reply({ headers: ['order_id'], data: [['DSP-1042']], total: 1 }));
    vi.stubGlobal('fetch', fetch);
    const client = new ZetarisClient({
      baseUrl: 'http://zetaris.invalid',
      username: 'test-user',
      password: 'test-password'
    });
    expect((await client.query('SELECT order_id FROM orders')).rows).toEqual([
      { order_id: 'DSP-1042' }
    ]);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[1]![1].headers).toMatchObject({
      Authorization: 'Bearer test-token-one',
      'X-Org-ID': '7'
    });
    expect(fetch.mock.calls[3]![1].headers).toMatchObject({
      Authorization: 'Bearer test-token-two',
      'X-Org-ID': '7'
    });
  });

  it.each(['jwt', 'opaque'] as const)(
    'refreshes a cached %s Zetaris token before sending a query after expiry',
    async (kind) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-26T20:00:00Z'));
      const expiry = Math.floor(Date.now() / 1000) + 90;
      const token =
        kind === 'jwt'
          ? `header.${Buffer.from(JSON.stringify({ exp: expiry })).toString('base64url')}.signature`
          : 'opaque-token';
      const fetch = vi
        .fn()
        .mockImplementation(async (url: string) =>
          url.endsWith('/api/auth/login')
            ? reply({ idToken: token, orgId: 7 })
            : reply({ headers: ['value'], data: [['1']] })
        );
      vi.stubGlobal('fetch', fetch);
      const client = new ZetarisClient({
        baseUrl: 'http://zetaris.invalid',
        username: 'test-user',
        password: 'test-password'
      });
      await client.query('SELECT 1');
      await client.query('SELECT 1');
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/api/auth/login'))).toHaveLength(1);
      vi.setSystemTime(Date.now() + 60_001);
      await client.query('SELECT 1');
      expect(fetch.mock.calls.filter(([url]) => url.endsWith('/api/auth/login'))).toHaveLength(2);
      expect(fetch).toHaveBeenCalledTimes(5);
    }
  );

  it('handles a non-string Zetaris error message without throwing a TypeError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(reply({ idToken: 'test-token', orgId: 7 }))
        .mockResolvedValueOnce(reply({ msg: { reason: 'Unavailable' } }, 500))
    );
    const client = new ZetarisClient({
      baseUrl: 'http://zetaris.invalid',
      username: 'test-user',
      password: 'test-password'
    });
    await expect(client.query('SELECT 1')).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
});
