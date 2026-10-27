/**
 * Catalogue nouns live in the item description and SKU, not in UI copy.
 * Dispatching reads stay generic: a chair order says "chairs", a linen order says "linen".
 */
const UNITS: Array<{ prefix: string; one: string; many: string }> = [
  { prefix: 'CHR-', one: 'chair', many: 'chairs' },
  { prefix: 'TBL-', one: 'table', many: 'tables' },
  { prefix: 'LIN-', one: 'linen', many: 'linen' }
];

export function itemUnitLabel(sku: string, quantity = 2): string {
  const unit = UNITS.find((candidate) => sku.startsWith(candidate.prefix));
  if (!unit) return 'units';
  return quantity === 1 ? unit.one : unit.many;
}

/** "60 chairs", "1 table", "40 linen". */
export function formatQuantityWithUnit(quantity: number, sku: string): string {
  return `${quantity} ${itemUnitLabel(sku, quantity)}`;
}
