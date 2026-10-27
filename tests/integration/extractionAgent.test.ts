import { afterEach, describe, it, expect, vi } from 'vitest';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { DEMO_SUPPLIER_MESSAGE } from '../../src/demo/seedData';
import {
  ModelBudgetExceededError,
  ModelOutageError,
  UnresolvedQuoteError
} from '../../src/domain/errors';
import { MODEL_CALL_TOKEN_ALLOWANCE } from '../../src/domain/executionLimits';

const modelBody = (usage: Record<string, number>, content = '{"ok":true}') => ({
  choices: [{ message: { content } }],
  usage
});

function stubbedAgent(): NvidiaExtractionAgent {
  return new NvidiaExtractionAgent({
    apiKey: 'nvapi-test-live-shape',
    baseUrl: 'http://nvidia.test/v1'
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NVIDIA extraction boundary', () => {
  it('throws ModelOutageError when live model call fails and never substitutes silent fixture data', async () => {
    const offlineAgent = new NvidiaExtractionAgent({
      apiKey: 'nvapi-test-offline',
      baseUrl: 'http://127.0.0.1:1/unreachable-v1'
    });

    await expect(
      offlineAgent.extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText)
    ).rejects.toThrow(ModelOutageError);
  });

  it('rejects fabricated quotes and tampered ignored instructions with UnresolvedQuoteError', () => {
    const agent = NvidiaExtractionAgent.createWithMock();
    expect(() =>
      agent.verifyQuotesInSource(DEMO_SUPPLIER_MESSAGE.rawMessageText, [
        {
          quote: 'fabricated quote not present in message',
          claim: 'false claim'
        }
      ])
    ).toThrow(UnresolvedQuoteError);
  });

  it('reports an over-allowance usage as MODEL_BUDGET_EXCEEDED, not a malformed model answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(
          modelBody({
            prompt_tokens: MODEL_CALL_TOKEN_ALLOWANCE,
            completion_tokens: 1,
            total_tokens: MODEL_CALL_TOKEN_ALLOWANCE + 1
          })
        )
      )
    );

    const failure = await stubbedAgent()
      .extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ModelBudgetExceededError);
    expect(failure).toMatchObject({ code: 'MODEL_BUDGET_EXCEEDED' });
    expect((failure as Error).message).toContain('above the 16384-token call allowance');
    expect((failure as Error).message).not.toContain('Malformed JSON');
  });

  it('lets a budget stop from the usage ledger keep its own error instead of relabelling it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(modelBody({ prompt_tokens: 10, completion_tokens: 5 })))
    );
    const budgetStop = new ModelBudgetExceededError('Daily token budget exhausted.');

    const failure = await stubbedAgent()
      .extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText, 'MSG-1', {
        onReportedUsage: () => {
          throw budgetStop;
        }
      })
      .catch((err: unknown) => err);

    expect(failure).toBe(budgetStop);
    expect((failure as Error).message).not.toContain('Malformed JSON');
  });

  it('still labels invalid JSON content as a model outage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(modelBody({ prompt_tokens: 10, completion_tokens: 5 }, 'not json'))
      )
    );

    const failure = await stubbedAgent()
      .extractSupplierFindings(DEMO_SUPPLIER_MESSAGE.rawMessageText)
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(ModelOutageError);
    expect((failure as Error).message).toContain('Malformed JSON output from model');
  });
});
