import { describe, expect, it } from 'vitest';
import { listOrderSummaries, receiptIdFor } from '../../src/server/deskState';
import type { StateStore } from '../../src/server/stateStore';
import type { DecisionReceipt } from '../../src/domain/receipt';
import { DEMO_ORDER } from '../../src/demo/seedData';

const receipt = (overrides: Partial<DecisionReceipt> = {}): DecisionReceipt =>
  ({
    status: 'awaiting_approval',
    version: 2,
    financial: { requiresManagerApproval: true },
    calculations: { shortfall: 60 },
    ...overrides
  }) as unknown as DecisionReceipt;

function stateStoreWith(
  orders: Array<typeof DEMO_ORDER>,
  receipts: Record<string, DecisionReceipt | undefined>
): StateStore {
  return {
    sources: { listOrders: async () => orders },
    recoveryService: { getReceipt: (id: string) => receipts[id] }
  } as unknown as StateStore;
}

describe('order list projections', () => {
  it('derives the stable receipt id from the order id', () => {
    expect(receiptIdFor('DSP-1042')).toBe('RCP-DSP-1042-01');
    expect(receiptIdFor('DSP-1048')).toBe('RCP-DSP-1048-01');
  });

  it('shows an uninvestigated order without inventing receipt data', async () => {
    const summaries = await listOrderSummaries(stateStoreWith([DEMO_ORDER], {}));
    expect(summaries).toEqual([
      {
        orderId: 'DSP-1042',
        customerName: 'Mrs. Folashade Adeyemi',
        eventName: 'Adeyemi Wedding Ceremony',
        itemDescription: 'Gold Chiavari Banquet Chair',
        sku: 'CHR-GOLD-CHIAVARI',
        requiredQuantity: 120,
        deliveryDeadlineIso: '2026-10-24T09:00:00+01:00',
        operationalStatus: 'confirmed',
        receiptStatus: null,
        receiptVersion: null,
        statusLabel: 'Not investigated',
        shortfall: null
      }
    ]);
  });

  it('uses the receipt status, version, truth-bearing label and shortfall', async () => {
    const summaries = await listOrderSummaries(
      stateStoreWith([DEMO_ORDER], { 'RCP-DSP-1042-01': receipt() })
    );
    expect(summaries[0]).toMatchObject({
      receiptStatus: 'awaiting_approval',
      receiptVersion: 2,
      statusLabel: 'Awaiting manager approval',
      shortfall: 60
    });
  });

  it('labels a plan invalidated by a competing order as taken stock', async () => {
    const summaries = await listOrderSummaries(
      stateStoreWith([DEMO_ORDER], {
        'RCP-DSP-1042-01': receipt({ status: 'stale', invalidatedReason: 'backup_conflict' })
      })
    );
    expect(summaries[0]?.statusLabel).toBe('Backup stock taken — re-plan');
  });
});
