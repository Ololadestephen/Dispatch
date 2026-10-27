import type { DeskState } from '../client/deskState';
import { sourceTable } from '../client/format';
import { Mono, Pill } from './primitives';

/** Which data layer, router and model produced what is on screen. Every claim comes from state. */
export function IntegrationStrip({ state }: { state: DeskState }) {
  const { integrations, sources, receipt, worldModel } = state;
  const zetaris = integrations.sources === 'zetaris';
  const scout = receipt?.scout;
  const pendingMatches = worldModel.pendingMatches.length;
  const tables = [
    ...new Set(
      [sources.orders, sources.inventory].map((e) => sourceTable(e.sourceId).split('.')[0])
    )
  ];
  const model = integrations.extraction.model.split('/').pop() ?? integrations.extraction.model;

  const modelPill = (() => {
    if (receipt?.executionMode === 'live')
      return (
        <Pill tone="ok" dot>
          Live · {((receipt.modelRun?.latencyMs ?? 0) / 1000).toFixed(1)} s
        </Pill>
      );
    if (receipt?.executionMode === 'mock')
      return (
        <Pill tone="pending" dot>
          Mock output
        </Pill>
      );
    if (receipt?.executionMode === 'incomplete')
      return (
        <Pill tone="risk" dot>
          No output
        </Pill>
      );
    return integrations.extraction.mode === 'mock' ? (
      <Pill tone="pending" dot>
        Mock mode
      </Pill>
    ) : (
      <Pill dot>Not run yet</Pill>
    );
  })();

  return (
    <section className="integrations" aria-label="Integrations">
      <article className="integration">
        <div className="integration-head">
          <span className="eyebrow">Data</span>
          {zetaris ? (
            <Pill tone="ok" dot>
              Federated
            </Pill>
          ) : (
            <Pill tone="pending" dot>
              Not Zetaris
            </Pill>
          )}
        </div>
        <span className="integration-name">{zetaris ? 'Zetaris' : 'Local files'}</span>
        <span className="integration-meta">
          {zetaris
            ? `PostgreSQL + file tables · ${sources.topology.distinctBackingSystemsCount} table types`
            : 'SQLite, CSV and JSON read by Dispatch'}
        </span>
        {zetaris && <Mono>{tables.join(' · ')}</Mono>}
      </article>

      <article className="integration">
        <div className="integration-head">
          <span className="eyebrow">Routing</span>
          {scout ? (
            <Pill tone="ok" dot>
              Contract signed
            </Pill>
          ) : (
            <Pill dot>No contract yet</Pill>
          )}
        </div>
        <span className="integration-name">Meterless Scout</span>
        <span className="integration-meta">
          {scout
            ? `${scout.intent} · ${receipt?.investigationSteps?.length ?? 0} lookups · ${scout.band} confidence`
            : 'Spec implementation, rules only'}
        </span>
        {scout && <Mono>{scout.contractId}</Mono>}
      </article>

      <article className="integration">
        <div className="integration-head">
          <span className="eyebrow">Identity</span>
          {pendingMatches > 0 ? (
            <Pill tone="pending" dot>
              {pendingMatches} to review
            </Pill>
          ) : worldModel.context ? (
            <Pill tone="ok" dot>
              Context built
            </Pill>
          ) : (
            <Pill dot>Not built yet</Pill>
          )}
        </div>
        <span className="integration-name">Meterless World Model</span>
        <span className="integration-meta">Reference implementation · event-sourced mirror</span>
        <Mono>
          {worldModel.eventCount} events · {worldModel.headEventId}
        </Mono>
        {worldModel.context && (
          <span className="integration-meta">
            {worldModel.context.neighbours.length} linked · {worldModel.context.suppliers.length}{' '}
            supplier identities
          </span>
        )}
      </article>

      <article className="integration">
        <div className="integration-head">
          <span className="eyebrow">Model</span>
          {modelPill}
        </div>
        <span className="integration-name">
          {integrations.extraction.mode === 'mock' ? 'Test fixture' : 'NVIDIA NIM'}
        </span>
        <span className="integration-meta">
          {integrations.extraction.mode === 'mock'
            ? 'Injected for offline runs'
            : 'Direct call, not via Meterless'}
        </span>
        <Mono>{model}</Mono>
        {integrations.extraction.mode === 'live' &&
          (state.modelBudget.canCall ? (
            <span className="integration-meta">
              Budget: {state.modelBudget.remainingCalls} attempts ·{' '}
              {state.modelBudget.remainingTokens.toLocaleString()} tokens left
            </span>
          ) : (
            <Pill tone="risk">Model budget exhausted</Pill>
          ))}
      </article>
    </section>
  );
}
