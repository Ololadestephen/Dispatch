'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { IntegrationStrip } from '@/src/components/IntegrationStrip';
import { SourcesTile } from '@/src/components/SourceTiles';
import { MatchesTile } from '@/src/components/WorldModelTiles';

export default function SourcesPage() {
  const desk = useDeskContext();
  const { state, orders, pending } = desk;
  if (!state) return null;
  const orderId = state.sources.orders.data.orderId;

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Sources</h1>
        <label className="page-filter">
          Order
          <select
            value={orderId}
            disabled={pending !== null}
            onChange={(e) => void desk.loadOrder(e.target.value)}
          >
            {orders.map((order) => (
              <option key={order.orderId} value={order.orderId}>
                {order.orderId} · {order.eventName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <IntegrationStrip state={state} />
      <div className="bento">
        <SourcesTile
          state={state}
          busy={pending !== null}
          onOpen={desk.openSource}
          onRevise={(change) => desk.reviseSource(orderId, change)}
        />
        <MatchesTile
          state={state}
          busy={pending !== null}
          onResolve={(proposalId, decision) => {
            void desk.resolveWorldMatch(proposalId, decision);
          }}
        />
      </div>
    </>
  );
}
