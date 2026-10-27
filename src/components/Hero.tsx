'use client';

import type { DeskState } from '../client/deskState';
import { formatNaira, formatWat, weekdayWat } from '../client/format';
import { formatQuantityWithUnit } from '../domain/itemUnit';
import { FrozenClock } from '../domain/clock';
import { getBackupAvailabilityIssue, getRecoveryCandidateIssue } from '../domain/recoveryCandidate';
import { SlideConfirm } from './bencho/SlideConfirm';
import './bencho/SlideConfirm.css';

type EyebrowTone = '' | 'risk' | 'pending' | 'ok';

/** What the order's situation is right now, said once, from the receipt and sources only. */
function situation(state: DeskState): { tone: EyebrowTone; eyebrow: string; line: string } {
  const order = state.sources.orders.data;
  const r = state.receipt;
  const day = weekdayWat(order.deliveryDeadlineIso);
  if (!r) {
    return {
      tone: '',
      eyebrow: `Order ${order.operationalStatus} · Not investigated`,
      line: `${formatQuantityWithUnit(order.requiredQuantity, order.sku)} promised for ${day}.`
    };
  }
  switch (r.status) {
    case 'incomplete':
      return {
        tone: 'risk',
        eyebrow: 'Investigation incomplete',
        line: 'The supplier message could not be read.'
      };
    case 'stale':
      return {
        tone: 'risk',
        eyebrow: `${
          r.invalidatedReason === 'backup_conflict'
            ? 'Backup stock taken — re-plan'
            : 'Source changed — review required'
        }`,
        line: `${r.agentFindings.headline}.`
      };
    case 'awaiting_confirmation':
    case 'approved':
      return {
        tone: 'pending',
        eyebrow: 'Approved — not yet confirmed',
        line: `${r.agentFindings.headline}.`
      };
    case 'confirmed':
      return {
        tone: 'ok',
        eyebrow: 'Recovery confirmed (simulated)',
        line: `${formatQuantityWithUnit(order.requiredQuantity, order.sku)} covered for ${day}.`
      };
    case 'on_track':
      return {
        tone: 'ok',
        eyebrow: 'On track — no action needed',
        line: `${formatQuantityWithUnit(order.requiredQuantity, order.sku)} covered for ${day}.`
      };
    default:
      return {
        tone: 'risk',
        eyebrow: state.statusLabel ?? 'At risk',
        line: `${r.agentFindings.headline}.`
      };
  }
}

export function Hero({
  state,
  busy,
  investigating,
  onInvestigate,
  onApprove,
  onGoToConfirmation
}: {
  state: DeskState;
  busy: boolean;
  investigating: boolean;
  onInvestigate: () => void;
  onApprove: () => Promise<boolean>;
  onGoToConfirmation: () => void;
}) {
  const order = state.sources.orders.data;
  const r = state.receipt;
  const s = situation(state);
  const c = r?.calculations;
  const canApprove = state.currentUser.role === 'manager' || !r?.financial.requiresManagerApproval;
  const canInvestigate =
    !r || ['stale', 'incomplete', 'failed', 'proposed', 'awaiting_approval'].includes(r.status);
  const candidateIssue =
    r && ['proposed', 'awaiting_approval'].includes(r.status)
      ? getRecoveryCandidateIssue(r.candidateRemedy, {
          shortfallQuantity: r.calculations.shortfall,
          orderSku: r.calculations.sku,
          deliveryDeadlineIso: r.timing.deliveryDeadlineIso,
          transportBufferMinutes: r.timing.transportBufferMinutes,
          clock: new FrozenClock(r.scenarioClockIso)
        })
      : undefined;
  const availabilityIssue =
    r &&
    ['proposed', 'awaiting_approval'].includes(r.status) &&
    state.backupAvailability &&
    state.backupAvailability.reservedQuantity > 0
      ? getBackupAvailabilityIssue(state.backupAvailability, r.calculations.shortfall)
      : undefined;
  const approvalIssue = availabilityIssue ?? candidateIssue;

  return (
    <section className="hero" data-investigated={Boolean(r)} aria-label="Order">
      <div>
        <span className={`eyebrow ${s.tone}`}>
          <i className="dot" aria-hidden="true" />
          {s.eyebrow}
        </span>
        <h1 className="display">{s.line}</h1>
        <p className="order-meta">
          <span>{order.eventName}</span>
          <time dateTime={order.deliveryDeadlineIso}>{formatWat(order.deliveryDeadlineIso)}</time>
        </p>

        <div className="hero-actions">
          {r?.status === 'awaiting_approval' && (
            <>
              <SlideConfirm
                key={`approve-${r.version}`}
                width={300}
                label={`Slide to approve ${formatNaira(r.financial.extraCostKobo)}`}
                doneLabel="Approving"
                disabled={!canApprove || busy || Boolean(approvalIssue)}
                onConfirm={onApprove}
              />
              {!canApprove && <span className="hint">Manager approval required.</span>}
            </>
          )}
          {approvalIssue && <span className="pill pill-risk">{approvalIssue.message}</span>}
          {r?.status === 'awaiting_confirmation' && (
            <button className="btn btn-primary" onClick={onGoToConfirmation}>
              Record supplier confirmation
            </button>
          )}
          {canInvestigate && (
            <button
              className={`btn ${r?.status === 'awaiting_approval' ? '' : 'btn-primary'}`}
              disabled={busy}
              onClick={onInvestigate}
            >
              {investigating ? 'Investigating…' : r ? 'Investigate again' : 'Investigate'}
            </button>
          )}
        </div>
      </div>

      {c && (
        <dl className="stats" aria-label="Quantities">
          <div className="stat">
            <dt>Promised</dt>
            <dd>{order.requiredQuantity}</dd>
          </div>
          <div className="stat">
            <dt>Usable now</dt>
            <dd>{c.usableAvailable}</dd>
          </div>
          <div className="stat">
            <dt>Arriving in time</dt>
            <dd>{c.eligibleIncoming}</dd>
          </div>
          <div className="stat short" data-open={c.shortfall > 0 && r?.status !== 'confirmed'}>
            <dt>{r?.status === 'confirmed' ? 'Short at review' : 'Short'}</dt>
            <dd>{c.shortfall}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
