'use client';

import Link from 'next/link';
import { useDeskContext } from '@/src/client/DeskProvider';
import { IntegrationStrip } from '@/src/components/IntegrationStrip';
import { DotPanel } from '@/src/components/app/DotPanel';
import { Pill } from '@/src/components/primitives';

/** Where this order stands, one line per stage, each linking to its page. */
export default function OrderOverview() {
  const { state } = useDeskContext();
  if (!state) return null;
  const r = state.receipt;
  const base = `/app/orders/${encodeURIComponent(state.sources.orders.data.orderId)}`;
  const steps = r?.investigationSteps ?? [];

  return (
    <>
      <IntegrationStrip state={state} />
      {r ? (
        <section className="tile span-12" aria-label="Stages">
          <div className="tile-body">
            <ul className="list">
              <li>
                <Link href={`${base}/investigation`}>Investigation</Link>
                <span className="muted">
                  {steps.length} lookups{r.scout ? ' under a signed Scout contract' : ''}
                </span>
              </li>
              <li>
                <Link href={`${base}/decision`}>Decision</Link>
                <span className="muted">{r.agentFindings.headline}</span>
              </li>
              <li>
                <Link href={`${base}/recovery`}>Recovery</Link>
                {state.confirmation ? (
                  <Pill tone="ok" dot>
                    Confirmed (simulated)
                  </Pill>
                ) : state.approval ? (
                  <Pill tone="pending" dot>
                    Approved — not yet confirmed
                  </Pill>
                ) : (
                  <span className="muted">Nothing approved yet</span>
                )}
              </li>
            </ul>
          </div>
        </section>
      ) : (
        <DotPanel title="Not investigated yet." />
      )}
    </>
  );
}
