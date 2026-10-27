import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors';
import {
  OrderSourceSchema,
  parseSourceRecord,
  sourceInteger
} from '../../src/integrations/sources/schemas';
import { DEMO_ORDER } from '../../src/demo/seedData';

describe('source record validation', () => {
  it('accepts a complete demo order', () => {
    expect(parseSourceRecord(OrderSourceSchema, DEMO_ORDER, 'Order')).toEqual(DEMO_ORDER);
  });

  it('names the invalid field and the source on a schema violation', () => {
    const failure = (() => {
      try {
        parseSourceRecord(
          OrderSourceSchema,
          { ...DEMO_ORDER, requiredQuantity: -1 },
          'Order DSP-1042'
        );
      } catch (err) {
        return err;
      }
    })();
    expect(failure).toBeInstanceOf(DomainError);
    expect(failure).toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect((failure as Error).message).toContain('Order DSP-1042');
    expect((failure as Error).message).toContain('requiredQuantity');
  });

  it('rejects unknown fields rather than silently accepting them', () => {
    expect(() =>
      parseSourceRecord(OrderSourceSchema, { ...DEMO_ORDER, injected: true }, 'Order')
    ).toThrow(/injected/);
  });

  it('requires an offset on every source timestamp', () => {
    expect(() =>
      parseSourceRecord(
        OrderSourceSchema,
        { ...DEMO_ORDER, deliveryDeadlineIso: '2026-10-24T09:00:00' },
        'Order'
      )
    ).toThrow(DomainError);
  });

  it('parses nonnegative whole numbers from CSV text', () => {
    expect(sourceInteger('0', 'Count')).toBe(0);
    expect(sourceInteger('42', 'Count')).toBe(42);
  });

  it('rejects empty, signed, fractional and unsafe values instead of coercing', () => {
    for (const value of ['', ' 1', '-1', '1.5', '1e3', '9007199254740992']) {
      expect(() => sourceInteger(value, 'Count')).toThrow(/not a nonnegative whole number/);
    }
    expect(() => sourceInteger(3, 'Count')).toThrow(/not a nonnegative whole number/);
  });
});
