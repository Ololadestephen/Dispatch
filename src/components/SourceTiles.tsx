'use client';

import { useState } from 'react';
import type { AnySourceEnvelope, DeskState, SourceChange } from '../client/deskState';
import { BACKING_SYSTEM_LABELS, SOURCE_LABELS, shortHash, sourceTable } from '../client/format';
import { Mono, Pill, Tile } from './primitives';

function ReviseSources({
  state,
  busy,
  onRevise
}: {
  state: DeskState;
  busy: boolean;
  onRevise: (change: SourceChange) => void;
}) {
  const [damaged, setDamaged] = useState(String(state.sources.inventory.data.damaged));
  const [message, setMessage] = useState(state.sources.supplierUpdates.data.rawMessageText);
  const n = Number(damaged);
  const valid = damaged.trim() !== '' && Number.isInteger(n) && n >= 0;

  return (
    <details className="revise">
      <summary>Write a new source revision</summary>
      <form
        className="form-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onRevise({ sourceType: 'inventory', damaged: n });
        }}
      >
        <label>
          Damaged chairs
          <input
            inputMode="numeric"
            value={damaged}
            onChange={(e) => setDamaged(e.target.value)}
            aria-invalid={!valid}
          />
        </label>
        <button className="btn" disabled={busy || !valid}>
          Save stock revision
        </button>
      </form>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onRevise({ sourceType: 'supplier_updates', rawMessageText: message });
        }}
      >
        <label>
          Supplier message
          <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || message.trim().length < 10}>
          Save message revision
        </button>
      </form>
    </details>
  );
}

export function SourcesTile({
  state,
  busy,
  onOpen,
  onRevise
}: {
  state: DeskState;
  busy: boolean;
  onOpen: (envelope: AnySourceEnvelope) => void;
  onRevise: (change: SourceChange) => void;
}) {
  const s = state.sources;
  const envelopes = [
    s.orders,
    s.inventory,
    s.inboundShipments,
    s.supplierUpdates,
    s.backupListing
  ].filter((e): e is NonNullable<typeof e> => e !== null);
  return (
    <Tile
      title="Sources"
      className="span-7"
      aside={
        s.providerMode === 'zetaris' ? (
          <Pill tone="ok">Read through Zetaris</Pill>
        ) : (
          <Pill tone="pending">Local files</Pill>
        )
      }
    >
      <ul className="sources">
        {envelopes.map((e) => (
          <li key={e.sourceType}>
            <button className="source" onClick={() => onOpen(e)}>
              <span className="source-name">{SOURCE_LABELS[e.sourceType]}</span>
              <span className="muted">
                {BACKING_SYSTEM_LABELS[e.backingSystem] ?? e.backingSystem}
              </span>
              <Mono>{sourceTable(e.sourceId)}</Mono>
              <Mono>
                {e.revisionId} · {shortHash(e.snapshotHash)}
              </Mono>
            </button>
          </li>
        ))}
      </ul>
      <ReviseSources
        key={`${s.inventory.revisionId}:${s.supplierUpdates.revisionId}`}
        state={state}
        busy={busy}
        onRevise={onRevise}
      />
    </Tile>
  );
}

export function HistoryTile({ state }: { state: DeskState }) {
  if (state.auditEvents.length === 0) return null;
  return (
    <Tile title="History" className="span-5">
      <ol className="audit">
        {state.auditEvents.map((e) => (
          <li key={e.eventId}>
            <span className="audit-who">
              {e.actorName.split(' (')[0]} · v{e.receiptVersion}
            </span>
            <span>{e.summary}</span>
          </li>
        ))}
      </ol>
    </Tile>
  );
}
