'use client';

import type { ReactNode } from 'react';
import DotGrid from '../reactbits/DotGrid';
import '../reactbits/DotGrid.css';

/** A quiet dotted panel (React Bits DotGrid) for states where there is nothing to show yet. */
export function DotPanel({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="empty-panel dotted" style={{ position: 'relative', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        <DotGrid
          dotSize={3}
          gap={16}
          baseColor="#d4d4cf"
          activeColor="#176b58"
          proximity={110}
          intro={false}
          clickShock={false}
        />
      </div>
      <div style={{ position: 'relative', display: 'grid', justifyItems: 'center', gap: 12 }}>
        <p className="page-title" style={{ fontSize: '1.3rem' }}>
          {title}
        </p>
        {children}
      </div>
    </section>
  );
}
