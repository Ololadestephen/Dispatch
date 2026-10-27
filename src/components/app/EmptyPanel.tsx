import type { ReactNode } from 'react';

/** A plain empty state; the page's primary action stays in the shared header. */
export function EmptyPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="empty-panel">
      <p>{title}</p>
      {children}
    </section>
  );
}
