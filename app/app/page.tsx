'use client';

import Link from 'next/link';
import { useDeskContext } from '@/src/client/DeskProvider';
import { formatWat } from '@/src/client/format';
import { Pill, statusTone } from '@/src/components/primitives';

/** The orders the backend holds. Today that is one sample order; nothing here is padded out. */
export default function OrdersPage() {
  const { state } = useDeskContext();
  if (!state) return null;
  const order = state.sources.orders.data;
  const r = state.receipt;
  const href = `/app/orders/${encodeURIComponent(order.orderId)}`;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Orders</h1>
        <span className="caption">1 order</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Event</th>
            <th scope="col">Items</th>
            <th scope="col">Deliver by</th>
            <th scope="col">Status</th>
            <th scope="col">Short</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <Link href={href}>{order.orderId}</Link>
            </td>
            <td>{order.eventName}</td>
            <td>
              {order.requiredQuantity} × {order.itemDescription}
            </td>
            <td>{formatWat(order.deliveryDeadlineIso)}</td>
            <td>
              {r ? (
                <Pill tone={statusTone(r.status)} dot>
                  {state.statusLabel}
                </Pill>
              ) : (
                <Pill dot>Not investigated</Pill>
              )}
            </td>
            <td>{r ? r.calculations.shortfall : '—'}</td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
