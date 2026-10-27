'use client';

import type { DeskState } from '../client/deskState';
import type { WorldEntity, WorldMatch } from '../domain/worldModel';
import { formatWat, SOURCE_LABELS } from '../client/format';
import { Mono, Pill, Tile } from './primitives';

const entityLabel = (entity: WorldEntity) => entity.name ?? entity.id;

function MatchRow({
  match,
  manager,
  busy,
  onResolve
}: {
  match: WorldMatch;
  manager: boolean;
  busy: boolean;
  onResolve: (proposalId: string, decision: 'approve' | 'reject') => void;
}) {
  const pending = match.status === 'pending';
  return (
    <li className="match">
      <div className="match-head">
        <span className="match-names">
          {match.leftName}{' '}
          <span className="muted">{pending ? '↔' : match.status === 'approved' ? '→' : '≠'}</span>{' '}
          {match.rightName}
        </span>
        {pending ? (
          <span className="caption">{match.similarity.toFixed(3)} · review band</span>
        ) : (
          <Pill tone={match.status === 'approved' ? 'ok' : 'neutral'}>
            {match.status === 'approved' ? 'Merged' : 'Kept separate'}
          </Pill>
        )}
      </div>
      <div className="match-head">
        <span className="muted">
          {pending
            ? `Proposed ${formatWat(match.proposedAt)}`
            : `${match.resolvedBy ?? 'Manager'} · ${match.resolvedAt ? formatWat(match.resolvedAt) : ''}`}
        </span>
        {pending &&
          (manager ? (
            <span className="match-actions">
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => onResolve(match.proposalId, 'approve')}
              >
                Approve merge
              </button>
              <button
                className="btn btn-quiet"
                disabled={busy}
                onClick={() => onResolve(match.proposalId, 'reject')}
              >
                Reject
              </button>
            </span>
          ) : (
            <Pill tone="pending">Manager decision required</Pill>
          ))}
      </div>
    </li>
  );
}

/** The review band queue. Only a manager can resolve; nothing here changes a plan by itself. */
export function MatchesTile({
  state,
  busy,
  onResolve
}: {
  state: DeskState;
  busy: boolean;
  onResolve: (proposalId: string, decision: 'approve' | 'reject') => void;
}) {
  const pending = state.worldModel.pendingMatches;
  const recent = state.worldModel.recentMatches;
  const manager = state.currentUser.role === 'manager';
  if (pending.length === 0 && recent.length === 0) return null;

  return (
    <Tile
      title="Matches to review"
      className="span-12"
      aside={pending.length > 0 ? <Pill tone="pending">{pending.length} pending</Pill> : undefined}
    >
      <ul className="match-list">
        {pending.map((match) => (
          <MatchRow
            key={match.proposalId}
            match={match}
            manager={manager}
            busy={busy}
            onResolve={onResolve}
          />
        ))}
        {recent.map((match) => (
          <MatchRow
            key={match.proposalId}
            match={match}
            manager={manager}
            busy={busy}
            onResolve={onResolve}
          />
        ))}
      </ul>
    </Tile>
  );
}

/** Shows the receipt's identity snapshot beside the current mirrored order context. */
export function WorldModelTile({ state }: { state: DeskState }) {
  const model = state.worldModel;
  const context = model.context;
  const cited = state.receipt?.worldModel;
  const headMoved = cited !== undefined && cited.eventId !== model.headEventId;

  return (
    <Tile title="World Model" className="span-12">
      <details className="record-details">
        <summary>Event details</summary>
        <dl className="facts">
          <div>
            <dt>Engine</dt>
            <dd>{model.implementation}</dd>
          </div>
          <div>
            <dt>Namespace</dt>
            <dd>{model.namespace}</dd>
          </div>
          <div>
            <dt>Storage</dt>
            <dd>{model.storage === 'local' ? 'Local JSON' : 'Memory'}</dd>
          </div>
          <div>
            <dt>Current event</dt>
            <dd>
              {model.headEventId} <span className="muted">#{model.headEventSeq}</span>
            </dd>
          </div>
          <div>
            <dt>Receipt cited</dt>
            <dd>{cited ? `${cited.eventId} #${cited.eventSeq}` : 'Not recorded'}</dd>
          </div>
        </dl>
      </details>
      {headMoved && <Pill tone="pending">Receipt cites an earlier identity snapshot</Pill>}

      {context ? (
        <>
          <div>
            <h3 className="subhead">
              {cited ? 'Suppliers at receipt event' : 'Resolved suppliers'}
            </h3>
            <ul className="match-list">
              {(cited?.resolvedSuppliers ?? context.suppliers).map((supplier) => (
                <li className="match" key={supplier.canonicalId}>
                  <div className="match-head">
                    <span className="match-names">{supplier.names.join(' / ')}</span>
                    {(supplier.status === 'pending_review' || supplier.status === 'merged') && (
                      <Pill tone={supplier.status === 'pending_review' ? 'pending' : 'ok'}>
                        {supplier.status === 'pending_review' ? 'Awaiting manager' : 'Merged'}
                      </Pill>
                    )}
                  </div>
                  <details className="record-details">
                    <summary>Source records</summary>
                    <ul className="source-records">
                      {supplier.sourceRecords.map((record) => (
                        <li key={`${record.sourceType}:${record.recordId}`}>
                          <span>
                            {SOURCE_LABELS[record.sourceType as keyof typeof SOURCE_LABELS] ??
                              record.sourceType}
                          </span>
                          <Mono>{record.recordId}</Mono>
                          <Mono>{record.revisionId}</Mono>
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </div>

          <details className="record-details">
            <summary>Linked records for {entityLabel(context.order)}</summary>
            <ul className="list">
              {context.neighbours.map((neighbour) => (
                <li key={`${neighbour.via}:${neighbour.entity.id}`}>
                  <span>
                    <Mono>{neighbour.via}</Mono> {entityLabel(neighbour.entity)}
                  </span>
                  <span className="muted">
                    {neighbour.entity.type} · {neighbour.entity.id}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <p className="empty">The order has not been mirrored yet.</p>
      )}
      {model.pendingMatches.length > 0 && (
        <span className="muted">
          {model.pendingMatches.length} supplier matches need manager review.
        </span>
      )}
    </Tile>
  );
}
