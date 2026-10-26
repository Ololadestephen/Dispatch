import { describe, it, expect } from 'vitest';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import { DEMO_SUPPLIER_MESSAGE } from '../../src/demo/seedData';
import { ModelOutageError, UnresolvedQuoteError } from '../../src/domain/errors';

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
});
