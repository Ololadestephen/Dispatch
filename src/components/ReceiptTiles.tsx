'use client';

import { useState } from 'react';
import type { DecisionReceipt, DeskState } from '../client/deskState';
import type { BackupAvailability } from '../domain/reservation';
import { formatNaira, formatWat, LOOKUP_LABELS, sourceTable } from '../client/format';
import { formatQuantityWithUnit } from '../domain/itemUnit';
import { Mono, Pill, Tile } from './primitives';
import { StepPlayer } from './bencho/StepPlayer';
import './bencho/StepPlayer.css';

export function DecisionTile({ receipt }: { receipt: DecisionReceipt }) {
  const c = receipt.calculations;
  const { timing, candidateRemedy } = receipt;
  const cutoffMs = Date.parse(timing.latestEligibleArrivalIso);
  const kindOf = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 'unknown' : ms > cutoffMs ? 'late' : 'ok';
  };
  const entries = [
    {
      label: 'Original supplier',
      iso: timing.supplierExpectedArrivalIso,
      kind: kindOf(timing.supplierExpectedArrivalIso)
    },
    { label: `Latest usable arrival`, iso: timing.latestEligibleArrivalIso, kind: 'cutoff' },
    { label: 'Delivery deadline', iso: timing.deliveryDeadlineIso, kind: 'deadline' },
    ...(candidateRemedy
      ? [
          {
            label: `${candidateRemedy.supplierName} listing`,
            iso: candidateRemedy.statedDeliveryArrivalIso,
            kind: kindOf(candidateRemedy.statedDeliveryArrivalIso)
          }
        ]
      : [])
  ].sort((a, b) => (Date.parse(a.iso) || Infinity) - (Date.parse(b.iso) || Infinity));
  const WORD: Record<string, string> = { late: 'Too late', ok: 'In time', unknown: 'Not verified' };
  const rows: Array<[string, string]> = [
    ['Required', `${c.requiredQuantity}`],
    ['In warehouse', `${c.physicallyPresent}`],
    ['Damaged', `− ${c.damaged}`],
    ['Allocated elsewhere', `− ${c.activeAllocations}`],
    ['Usable', `${c.usableAvailable}`],
    ['Arriving in time', `+ ${c.eligibleIncoming}`]
  ];

  return (
    <Tile
      title={`Decision receipt v${receipt.version}`}
      className="span-7"
      aside={<Pill>Computed by code</Pill>}
    >
      <div className="decision">
        <table className="math">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{value}</td>
              </tr>
            ))}
            <tr className="math-total">
              <th scope="row">Short</th>
              <td>{c.shortfall}</td>
            </tr>
          </tbody>
        </table>
        <ol className="timeline" aria-label="Arrivals against the deadline">
          {entries.map((e) => (
            <li key={e.label} className={`tl-${e.kind}`}>
              <span className="tl-time">{formatWat(e.iso)}</span>
              <span>{e.label}</span>
              {WORD[e.kind] && <span className="tl-word">{WORD[e.kind]}</span>}
            </li>
          ))}
        </ol>
      </div>
      {receipt.agentFindings.uncertainties.length > 0 && (
        <ul className="questions" aria-label="Open questions">
          {receipt.agentFindings.uncertainties.map((u) => (
            <li key={u}>{u}</li>
          ))}
        </ul>
      )}
    </Tile>
  );
}

export function OptionTile({
  receipt,
  availability
}: {
  receipt: DecisionReceipt;
  availability?: BackupAvailability | null;
}) {
  const o = receipt.candidateRemedy;
  const f = receipt.financial;
  const holders = availability ? [...new Set(availability.reservations.map((r) => r.orderId))] : [];
  const holderLabel = holders
    .map((orderId) => (orderId === receipt.orderId ? 'this plan' : orderId))
    .join(', ');
  const actionable = ['proposed', 'awaiting_approval'].includes(receipt.status);
  return (
    <Tile
      title="Recovery option"
      className="span-5"
      aside={<Pill tone="pending">Listing — not confirmed</Pill>}
    >
      {o ? (
        <>
          <dl className="facts">
            <div>
              <dt>Supplier</dt>
              <dd>{o.supplierName}</dd>
            </div>
            <div>
              <dt>Available</dt>
              <dd>
                {formatQuantityWithUnit(
                  availability?.availableQuantity ?? o.availableQuantity,
                  receipt.calculations.sku
                )}
              </dd>
            </div>
            <div>
              <dt>Reserved</dt>
              <dd>
                {availability && availability.reservedQuantity > 0
                  ? `${formatQuantityWithUnit(availability.reservedQuantity, receipt.calculations.sku)} · ${holderLabel}`
                  : 'None'}
              </dd>
            </div>
            <div>
              <dt>Stated arrival</dt>
              <dd>{formatWat(o.statedDeliveryArrivalIso)}</dd>
            </div>
            <div>
              <dt>Extra cost</dt>
              <dd>{formatNaira(o.costKobo)}</dd>
            </div>
          </dl>
          <div className="row">
            <Pill tone={o.isEligibleByDeadline ? 'ok' : 'risk'} dot>
              {o.isEligibleByDeadline ? 'Arrives in time' : 'Arrives too late'}
            </Pill>
            {actionable && (
              <Pill tone={f.requiresManagerApproval ? 'risk' : 'neutral'}>
                {f.requiresManagerApproval ? 'Manager approval required' : 'Within operator limit'}
              </Pill>
            )}
          </div>
        </>
      ) : (
        <p className="empty">No backup listing for this item.</p>
      )}
    </Tile>
  );
}

const STATUS_TONE = { ok: 'ok', missing: 'pending', error: 'risk' } as const;

/** Replays the lookups that actually ran under the Scout contract, one per dot. */
export function LookupsTile({ receipt }: { receipt: DecisionReceipt }) {
  const steps = receipt.investigationSteps ?? [];
  const [at, setAt] = useState(0);
  const step = steps[Math.min(at, steps.length - 1)];
  if (!step) return null;

  return (
    <Tile
      title="Lookups"
      className="span-7"
      aside={receipt.scout ? <Pill tone="ok">Under Scout contract</Pill> : <Pill>No contract</Pill>}
    >
      {steps.length >= 3 && (
        <StepPlayer key={receipt.version} steps={steps.length} pace={1.6} onStep={setAt} />
      )}
      <div className="step-now" aria-live="polite">
        <div className="step-now-title">
          <span>
            {step.stepIndex}. {LOOKUP_LABELS[step.tool]}
          </span>
          <Pill tone={STATUS_TONE[step.status]}>{step.status}</Pill>
        </div>
        <span>{step.outcomeSummary}</span>
        {step.selectedBy === 'model' && <span>Model requested: {step.selectionReason}</span>}
        <Mono>{sourceTable(step.sourceId)}</Mono>
        <Mono>
          {step.recordId} · {step.revisionId}
        </Mono>
      </div>
      <ol className="steps">
        {steps.map((s, i) => (
          <li key={s.stepIndex}>
            <div className="step-row" aria-current={i === at ? 'step' : undefined}>
              <span className="step-index">{s.stepIndex}</span>
              <span>
                {LOOKUP_LABELS[s.tool]} <Mono>{sourceTable(s.sourceId)}</Mono>
              </span>
              <Pill tone={STATUS_TONE[s.status]}>{s.status}</Pill>
            </div>
          </li>
        ))}
      </ol>
    </Tile>
  );
}

interface Span {
  start: number;
  end: number;
  kind: 'quote' | 'ignored';
}

function highlight(text: string, spans: Span[]) {
  const out: React.ReactNode[] = [];
  let cursor = 0;
  [...spans]
    .sort((a, b) => a.start - b.start)
    .forEach((sp, i) => {
      if (sp.start < cursor) return;
      out.push(text.slice(cursor, sp.start));
      out.push(
        <mark key={i} className={`mark-${sp.kind}`}>
          {text.slice(sp.start, sp.end)}
        </mark>
      );
      cursor = sp.end;
    });
  out.push(text.slice(cursor));
  return out;
}

export function SupplierMessageTile({ state }: { state: DeskState }) {
  const msg = state.sources.supplierUpdates;
  const r = state.receipt;
  // Spans only apply to the exact revision the receipt read.
  const sameRevision = r?.sourceRevisions.some((s) => s.revisionId === msg.revisionId) ?? false;
  const ignored = sameRevision ? (r?.agentFindings.ignoredInstructionSpans ?? []) : [];
  const spans: Span[] = sameRevision
    ? [
        ...(r?.agentFindings.extractedQuotes ?? []).flatMap((q) =>
          q.startIndex !== undefined && q.endIndex !== undefined
            ? [{ start: q.startIndex, end: q.endIndex, kind: 'quote' as const }]
            : []
        ),
        ...ignored.map((s) => ({ start: s.startIndex, end: s.endIndex, kind: 'ignored' as const }))
      ]
    : [];

  return (
    <Tile title="Supplier message" className="span-5" aside={<Mono>{msg.revisionId}</Mono>}>
      <p className="message">{highlight(msg.data.rawMessageText, spans)}</p>
      <span className="muted">
        {msg.data.supplierName} · {formatWat(msg.data.receivedAtIso)}
      </span>
      {ignored.map((sp) => (
        <div className="ignored" key={sp.startIndex}>
          <strong>Ignored: “{sp.text}”</strong>
          <div className="chips">
            {(sp.detectedBy ?? []).map((d) => (
              <Pill key={d} tone="risk">
                {d === 'model' ? 'Found by model' : 'Found by Scout'}
              </Pill>
            ))}
            <Pill>No state change</Pill>
          </div>
        </div>
      ))}
    </Tile>
  );
}
