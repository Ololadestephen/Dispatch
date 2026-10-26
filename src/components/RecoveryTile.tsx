'use client';

import { useState } from 'react';
import type { ConfirmationInput, DeskState } from '../client/deskState';
import { formatNaira, formatWat } from '../client/format';
import { Mono, Pill, Tile } from './primitives';
import { SlideConfirm } from './bencho/SlideConfirm';
import './bencho/SlideConfirm.css';

type Draft = NonNullable<DeskState['supplierDraft']>;

function ConfirmationForm({
  draft,
  busy,
  onConfirm
}: {
  draft: Draft;
  busy: boolean;
  onConfirm: (input: ConfirmationInput) => Promise<boolean>;
}) {
  const [quantity, setQuantity] = useState('');
  const [arrival, setArrival] = useState('');
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState('');

  // The demo has no supplier channel: this fills in a reply that says it is simulated.
  const fillSimulated = () => {
    setQuantity(String(draft.requestedQuantity));
    setArrival(draft.requiredDeliveryByIso);
    setReference(`SIM-${draft.draftId.slice(-6)}`);
    setEvidence(
      `Simulated reply from ${draft.supplierName}: ${draft.requestedQuantity} × ${draft.sku} confirmed for ${formatWat(draft.requiredDeliveryByIso)}.`
    );
  };

  const qty = Number(quantity);
  const ready =
    Number.isInteger(qty) &&
    qty > 0 &&
    arrival !== '' &&
    reference !== '' &&
    evidence.trim().length >= 10;

  return (
    <div className="form">
      <div className="form-row">
        <label>
          Quantity
          <input
            inputMode="numeric"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label>
          Arrives (ISO, WAT)
          <input
            value={arrival}
            onChange={(e) => setArrival(e.target.value)}
            placeholder="2026-10-24T07:00:00+01:00"
          />
        </label>
        <label>
          Reference
          <input value={reference} onChange={(e) => setReference(e.target.value)} />
        </label>
      </div>
      <label>
        Supplier evidence
        <textarea rows={3} value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" className="btn" onClick={fillSimulated}>
          Use simulated reply
        </button>
        <SlideConfirm
          width={300}
          label="Slide to record confirmation"
          doneLabel="Recording"
          disabled={!ready || busy}
          onConfirm={() =>
            onConfirm({
              supplierName: draft.supplierName,
              sku: draft.sku,
              confirmedQuantity: qty,
              confirmedArrivalIso: arrival,
              confirmationReference: reference,
              evidenceExcerpt: evidence
            })
          }
        />
      </div>
    </div>
  );
}

export function RecoveryTile({
  state,
  busy,
  onConfirm
}: {
  state: DeskState;
  busy: boolean;
  onConfirm: (input: ConfirmationInput) => Promise<boolean>;
}) {
  const { approval, tasks, supplierDraft, confirmation, receipt } = state;
  const [copied, setCopied] = useState(false);
  if (!approval) return null;

  return (
    <Tile
      id="recovery"
      title={`Recovery · plan v${approval.receiptVersion}`}
      aside={
        confirmation ? (
          <Pill tone="ok" dot>
            Recovery confirmed
          </Pill>
        ) : (
          <Pill tone="pending" dot>
            Approved — not yet confirmed
          </Pill>
        )
      }
    >
      <div className="decision">
        <div className="form">
          <span className="eyebrow">Approved</span>
          <span>
            {approval.approvedByName} · {formatWat(approval.approvedAtIso)}
          </span>
          <ul className="list" aria-label="Tasks">
            {tasks.map((t) => (
              <li key={t.taskId}>
                <span>{t.title}</span>
                <Pill>{t.assignedRole}</Pill>
              </li>
            ))}
          </ul>
        </div>
        {supplierDraft && (
          <div className="form">
            <div className="row">
              <span className="eyebrow">Supplier request</span>
              <Pill tone="pending">Draft — not sent</Pill>
            </div>
            <p className="draft">{supplierDraft.bodyText}</p>
            <div className="row">
              <span className="muted">
                {supplierDraft.requestedQuantity} × <Mono>{supplierDraft.sku}</Mono> ·{' '}
                {formatNaira(supplierDraft.offeredCostKobo)}
              </span>
              <button
                className="btn"
                onClick={() =>
                  navigator.clipboard
                    .writeText(supplierDraft.bodyText ?? '')
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              >
                {copied ? 'Copied' : 'Copy draft'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="form">
        <div className="row">
          <span className="eyebrow">Supplier confirmation</span>
          {confirmation && <Pill tone="pending">Simulated</Pill>}
        </div>
        {confirmation ? (
          <dl className="facts">
            <div>
              <dt>Reference</dt>
              <dd>
                <Mono>{confirmation.confirmationReference}</Mono>
              </dd>
            </div>
            <div>
              <dt>Confirmed</dt>
              <dd>
                {confirmation.confirmedQuantity} by {formatWat(confirmation.confirmedArrivalIso)}
              </dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{confirmation.evidenceExcerpt}</dd>
            </div>
            <div>
              <dt>Recorded by</dt>
              <dd>{confirmation.recordedByName}</dd>
            </div>
          </dl>
        ) : receipt?.status === 'awaiting_confirmation' && supplierDraft ? (
          <ConfirmationForm draft={supplierDraft} busy={busy} onConfirm={onConfirm} />
        ) : (
          <p className="empty">No confirmation recorded.</p>
        )}
      </div>
    </Tile>
  );
}
