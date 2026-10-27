import { describe, expect, it } from 'vitest';
import { formatQuantityWithUnit, itemUnitLabel } from '../../src/domain/itemUnit';

describe('catalogue unit grammar', () => {
  it('derives the noun from the SKU prefix', () => {
    expect(itemUnitLabel('CHR-GOLD-CHIAVARI')).toBe('chairs');
    expect(itemUnitLabel('TBL-ROUND-72')).toBe('tables');
    expect(itemUnitLabel('LIN-IVORY-120')).toBe('linen');
  });

  it('uses the singular only for exactly one unit', () => {
    expect(itemUnitLabel('CHR-GOLD-CHIAVARI', 1)).toBe('chair');
    expect(itemUnitLabel('TBL-ROUND-72', 1)).toBe('table');
    expect(itemUnitLabel('LIN-IVORY-120', 0)).toBe('linen');
  });

  it('falls back to a generic noun for an unknown catalogue prefix', () => {
    expect(itemUnitLabel('UNKNOWN-SKU')).toBe('units');
    expect(itemUnitLabel('UNKNOWN-SKU', 1)).toBe('units');
  });

  it('formats a quantity with the derived noun', () => {
    expect(formatQuantityWithUnit(60, 'CHR-GOLD-CHIAVARI')).toBe('60 chairs');
    expect(formatQuantityWithUnit(1, 'TBL-ROUND-72')).toBe('1 table');
    expect(formatQuantityWithUnit(40, 'LIN-IVORY-120')).toBe('40 linen');
  });
});
