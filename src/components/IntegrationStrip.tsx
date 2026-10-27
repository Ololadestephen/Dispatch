import type { DeskState } from '../client/deskState';
import { Mono, Pill } from './primitives';

/** Execution mode stays visible on every page, separate from optional technical details. */
export function ExtractionStatus({ state }: { state: DeskState }) {
  const receipt = state.receipt;
  if (receipt?.executionMode === 'live')
    return <Pill tone="ok">Live · {((receipt.modelRun?.latencyMs ?? 0) / 1000).toFixed(1)} s</Pill>;
  if (receipt?.executionMode === 'mock') return <Pill tone="pending">Mock output</Pill>;
  if (receipt?.executionMode === 'incomplete') return <Pill tone="risk">No model output</Pill>;
  return state.integrations.extraction.mode === 'mock' ? (
    <Pill tone="pending">Mock mode</Pill>
  ) : (
    <Pill>NVIDIA not run</Pill>
  );
}

/** A compact provenance row; full identifiers remain available on demand. */
export function IntegrationStrip({ state }: { state: DeskState }) {
  const { integrations, sources, receipt, worldModel, modelBudget } = state;
  const zetaris = integrations.sources === 'zetaris';
  const scout = receipt?.scout;
  const pending = worldModel.pendingMatches.length;
  const model = receipt?.modelRun?.model ?? integrations.extraction.model;

  return (
    <section className="integrations" aria-label="Integrations">
      <span>{zetaris ? 'Zetaris' : 'Local files'}</span>
      <span className="integration-status">
        Meterless Scout
        <span>{scout ? 'Contract signed' : 'No contract yet'}</span>
      </span>
      {pending > 0 && <Pill tone="pending">{pending} supplier matches to review</Pill>}
      {integrations.extraction.mode === 'live' && !modelBudget.canCall && (
        <Pill tone="risk">Model budget exhausted</Pill>
      )}
      <details className="integration-details">
        <summary>Integration details</summary>
        <dl className="facts">
          <div>
            <dt>Data</dt>
            <dd>
              {zetaris
                ? `Zetaris · PostgreSQL + file tables · ${sources.topology.distinctBackingSystemsCount} table types`
                : 'Local SQLite, CSV and JSON'}
            </dd>
          </div>
          <div>
            <dt>Scout contract</dt>
            <dd>{scout ? <Mono>{scout.contractId}</Mono> : 'Not issued'}</dd>
          </div>
          <div>
            <dt>World Model</dt>
            <dd>
              Meterless reference implementation · {worldModel.eventCount} events ·{' '}
              <Mono>{worldModel.headEventId}</Mono>
            </dd>
          </div>
          <div>
            <dt>Extraction</dt>
            <dd>
              {integrations.extraction.mode === 'mock'
                ? 'Offline test fixture'
                : 'Direct NVIDIA NIM call'}{' '}
              · <Mono>{model}</Mono>
            </dd>
          </div>
          {integrations.extraction.mode === 'live' && (
            <div>
              <dt>Remaining budget</dt>
              <dd>
                {modelBudget.remainingCalls} calls · {modelBudget.remainingTokens.toLocaleString()}{' '}
                token units
              </dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}
