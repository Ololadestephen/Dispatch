import type { ReactNode } from 'react';
import type { DecisionReceipt } from '../client/deskState';

export type Tone = 'risk' | 'pending' | 'ok' | 'neutral' | 'ink';

const TONE_BY_STATUS: Record<DecisionReceipt['status'], Tone> = {
  detected: 'risk',
  proposed: 'pending',
  awaiting_approval: 'risk',
  approved: 'pending',
  awaiting_confirmation: 'pending',
  confirmed: 'ok',
  rejected: 'risk',
  stale: 'risk',
  incomplete: 'risk',
  failed: 'risk'
};

export function statusTone(status: DecisionReceipt['status']): Tone {
  return TONE_BY_STATUS[status];
}

export function Pill({
  tone = 'neutral',
  dot,
  children
}: {
  tone?: Tone;
  dot?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={`pill${tone === 'neutral' ? '' : ` pill-${tone}`}`}>
      {dot && <i className="dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

export function Tile({
  title,
  aside,
  className = 'span-12',
  id,
  children
}: {
  title: string;
  aside?: ReactNode;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className={`tile ${className}`} id={id} aria-label={title}>
      <header className="tile-head">
        <h2>{title}</h2>
        {aside}
      </header>
      <div className="tile-body">{children}</div>
    </section>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}
