'use client';

import { useEffect, useRef } from 'react';
import type { AnySourceEnvelope } from '../client/deskState';
import { BACKING_SYSTEM_LABELS, SOURCE_LABELS, formatWat } from '../client/format';
import { Mono } from './primitives';

export interface HighlightSpan {
  startIndex: number;
  endIndex: number;
  kind: 'quote' | 'ignored';
}

/** Splits text into plain and highlighted runs; spans were resolved server-side. */
function renderHighlighted(text: string, spans: HighlightSpan[]) {
  const sorted = [...spans].sort((a, b) => a.startIndex - b.startIndex);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((span, i) => {
    if (span.startIndex < cursor) return;
    parts.push(text.slice(cursor, span.startIndex));
    parts.push(
      <mark key={i} className={`mark-${span.kind}`}>
        {text.slice(span.startIndex, span.endIndex)}
      </mark>
    );
    cursor = span.endIndex;
  });
  parts.push(text.slice(cursor));
  return parts;
}

function RecordFields({ data }: { data: Record<string, unknown> }) {
  return (
    <dl className="fields">
      {Object.entries(data)
        .filter(([key]) => key !== 'rawMessageText')
        .map(([key, value]) => (
          <div key={key}>
            <dt>{key}</dt>
            <dd>
              <Mono>{String(value)}</Mono>
            </dd>
          </div>
        ))}
    </dl>
  );
}

export function EvidenceDrawer({
  envelope,
  spans,
  onClose
}: {
  envelope: AnySourceEnvelope;
  spans: HighlightSpan[];
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const data = envelope.data as Record<string, unknown>;
  const rawText = typeof data.rawMessageText === 'string' ? data.rawMessageText : null;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`${SOURCE_LABELS[envelope.sourceType]} evidence`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-head">
          <h2>{SOURCE_LABELS[envelope.sourceType]}</h2>
          <button ref={closeRef} className="btn btn-quiet" onClick={onClose}>
            Close
          </button>
        </header>
        {rawText !== null && (
          <blockquote className="source-text">{renderHighlighted(rawText, spans)}</blockquote>
        )}
        {rawText === null && <RecordFields data={data} />}
        <details className="record-details">
          <summary>Source details</summary>
          <dl className="fields">
            <div>
              <dt>Record</dt>
              <dd>
                <Mono>{envelope.recordId}</Mono>
              </dd>
            </div>
            <div>
              <dt>Revision</dt>
              <dd>
                <Mono>{envelope.revisionId}</Mono>
              </dd>
            </div>
            <div>
              <dt>Stored in</dt>
              <dd>{BACKING_SYSTEM_LABELS[envelope.backingSystem] ?? envelope.backingSystem}</dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd>
                <Mono>{envelope.snapshotHash}</Mono>
              </dd>
            </div>
            <div>
              <dt>Read at</dt>
              <dd>{formatWat(envelope.timestampIso)}</dd>
            </div>
          </dl>
          {rawText !== null && <RecordFields data={data} />}
        </details>
      </aside>
    </div>
  );
}
