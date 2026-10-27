import { describe, expect, it } from 'vitest';
import { ModelLookupRequestsSchema } from '../../src/domain/lookupRequest';

const request = {
  tool: 'get_backup_listings',
  args: { sku: 'CHR-GOLD-CHIAVARI' },
  reason: 'Need a backup lot for the shortfall.'
};

describe('model lookup request contract', () => {
  it('accepts the single allowlisted backup lookup', () => {
    expect(ModelLookupRequestsSchema.parse([request])).toEqual([request]);
  });

  it('accepts no follow-up lookup', () => {
    expect(ModelLookupRequestsSchema.parse([])).toEqual([]);
  });

  it('rejects more than one follow-up', () => {
    expect(() => ModelLookupRequestsSchema.parse([request, request])).toThrow();
  });

  it('rejects a tool outside the allowlist', () => {
    expect(() => ModelLookupRequestsSchema.parse([{ ...request, tool: 'run_sql' }])).toThrow();
  });

  it('rejects unsafe SKU characters before they reach a query', () => {
    for (const sku of ['CHR; DROP TABLE', 'CHR GOLD', '../secret', '']) {
      expect(() => ModelLookupRequestsSchema.parse([{ ...request, args: { sku } }])).toThrow();
    }
  });

  it('rejects unknown fields at every level', () => {
    expect(() => ModelLookupRequestsSchema.parse([{ ...request, extra: true }])).toThrow();
    expect(() =>
      ModelLookupRequestsSchema.parse([{ ...request, args: { ...request.args, limit: 10 } }])
    ).toThrow();
  });

  it('requires a bounded, non-empty reason', () => {
    expect(() => ModelLookupRequestsSchema.parse([{ ...request, reason: '' }])).toThrow();
    expect(() =>
      ModelLookupRequestsSchema.parse([{ ...request, reason: 'x'.repeat(241) }])
    ).toThrow();
  });
});
