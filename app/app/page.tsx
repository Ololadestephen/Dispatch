'use client';

import Link from 'next/link';
import { useDeskContext } from '@/src/client/DeskProvider';
import { formatWat } from '@/src/client/format';
import { Pill, statusTone } from '@/src/components/primitives';

/** Every order in the synthetic workspace with its latest receipt status. */
export default function OrdersPage() {
  const { orders } = useDeskContext();

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Orders</h1>
        <span className="caption">
          {orders.length} {orders.length === 1 ? 'order' : 'orders'}
        </span>
      </div>
      <table className="table orders-table">
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
          {orders.map((order) => (
            <tr key={order.orderId}>
              <td>
                <Link href={`/app/orders/${encodeURIComponent(order.orderId)}`}>
                  {order.orderId}
                </Link>
              </td>
              <td>{order.eventName}</td>
              <td>
                {order.requiredQuantity} × {order.itemDescription}
              </td>
              <td data-label="Deliver by">{formatWat(order.deliveryDeadlineIso)}</td>
              <td>
                {order.receiptStatus ? (
                  <Pill tone={statusTone(order.receiptStatus)} dot>
                    {order.statusLabel}
                  </Pill>
                ) : (
                  <Pill dot>{order.statusLabel}</Pill>
                )}
              </td>
              <td data-label="Short">{order.shortfall ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {orders.length === 0 && <p className="empty">No orders in this workspace.</p>}
    </>
  );
}
