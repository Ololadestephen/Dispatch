'use client';

import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
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
  const desk = useDeskContext();
  const { state, pending, receiptForOrder } = useOrder(orderId);
  if (!state) return null;

  const base = `/app/orders/${encodeURIComponent(orderId)}`;
  if (state.sources.orders.data.orderId !== orderId) {
    return (
      <div className="empty-panel dotted">
        <h1 className="page-title">Order not found</h1>
        <Link href="/app" className="btn">
          Back to orders
        </Link>
      </div>
    );
  }

  return (
    <>
      <Hero
        state={state}
        busy={pending !== null}
        investigating={pending === 'investigate'}
        onInvestigate={() => desk.investigate(orderId)}
        onApprove={() =>
          receiptForOrder
            ? desk.approve(receiptForOrder.receiptId, receiptForOrder.version)
            : Promise.resolve(false)
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

function useOrder(orderId: string) {
  const { state, pending } = useDeskContext();
  const receiptForOrder = state?.receipt?.orderId === orderId ? state.receipt : null;
  return { state, pending, receiptForOrder };
}
