'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';
import { useDeskContext } from '@/src/client/DeskProvider';
import { Hero } from '@/src/components/Hero';

const TABS = [
  { slug: '', label: 'Overview' },
  { slug: 'investigation', label: 'Investigation' },
  { slug: 'decision', label: 'Decision' },
  { slug: 'recovery', label: 'Recovery' }
];

/** Every order page shares the header and its next action, so approval is one step from anywhere. */
export default function OrderLayout({ children }: { children: ReactNode }) {
  const { orderId } = useParams<{ orderId: string }>();
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const { state, pending, orderNotFound, loadOrder, investigate, approve } = useDeskContext();

  useEffect(() => {
    if (orderNotFound === orderId) return;
    if (state?.sources.orders.data.orderId === orderId) return;
    void loadOrder(orderId);
  }, [orderId, orderNotFound, loadOrder, state?.sources.orders.data.orderId]);

  const base = `/app/orders/${encodeURIComponent(orderId)}`;
  if (orderNotFound === orderId) {
    return (
      <div className="empty-panel dotted">
        <h1 className="page-title">Order not found</h1>
        <p className="muted">{orderId} is not in this workspace.</p>
        <Link href="/app" className="btn">
          Back to orders
        </Link>
      </div>
    );
  }

  if (!state || state.sources.orders.data.orderId !== orderId) {
    return (
      <div className="empty-panel dotted" aria-busy="true">
        <p className="muted">Loading {orderId}…</p>
      </div>
    );
  }

  const receipt = state.receipt?.orderId === orderId ? state.receipt : null;

  return (
    <>
      <Hero
        state={state}
        busy={pending !== null}
        investigating={pending === 'investigate'}
        onInvestigate={() => {
          void investigate(orderId);
        }}
        onApprove={() =>
          receipt ? approve(receipt.receiptId, receipt.version) : Promise.resolve(false)
        }
        onGoToConfirmation={() => router.push(`${base}/recovery`)}
      />
      <nav className="tabs" aria-label="Order sections">
        {TABS.map((tab) => {
          const href = tab.slug ? `${base}/${tab.slug}` : base;
          return (
            <Link key={tab.label} href={href} aria-current={pathname === href ? 'page' : undefined}>
              {tab.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </>
  );
}
