import { RecoveryStore } from '../persistence/recoveryStore';
import path from 'node:path';
import { createSourceGateway, SourceGateway } from '../integrations/sources';
import { NvidiaExtractionAgent } from '../integrations/nvidia/extractionAgent';
import { RecoveryService } from '../application/recoveryService';
import { InvestigationService } from '../application/investigationService';
import { snapshotToSourceRevisions } from '../application/investigationReceipt';
import { ExecutionLimitsSchema, type ExecutionLimits } from '../domain/executionLimits';
import { FrozenClock, FROZEN_SCENARIO_TIME_ISO } from '../domain/clock';
import {
  DEMO_ORDER,
  DEMO_WAREHOUSE,
  DEMO_SUPPLIER_MESSAGE,
  DEMO_BACKUP_LISTING,
  DEMO_INBOUND_SHIPMENT
} from '../demo/seedData';
import { UserSession } from '../domain/policy';
import { AppDatabase } from '../persistence/appDb';
import type { EvidenceSnapshot } from '../integrations/sources/types';
import { createDispatchScout } from '../integrations/meterless/dispatchScout';

export const DEMO_RECEIPT_ID = `RCP-${DEMO_ORDER.orderId}-01`;

const DEMO_SEED = {
  order: DEMO_ORDER,
  warehouse: DEMO_WAREHOUSE,
  supplierMessage: DEMO_SUPPLIER_MESSAGE,
  backupListing: DEMO_BACKUP_LISTING,
  inboundShipment: DEMO_INBOUND_SHIPMENT
};

export interface StateStoreOptions {
  /** Holds the source files and the app database. Defaults to $DISPATCH_DATA_DIR or ./data. */
  dataDir?: string;
  /** Private run evidence. Defaults to $DISPATCH_EVIDENCE_DIR or ./.local/evidence; null disables it. */
  evidenceDir?: string | null;
  extractionAgent?: NvidiaExtractionAgent;
  /** Source gateway; defaults to the one DISPATCH_SOURCES selects. */
  sources?: SourceGateway;
  executionLimits?: Partial<ExecutionLimits>;
}

/**
 * DISPATCH_EXTRACTION=mock selects the injected test fixture explicitly (npm run dev:mock, e2e).
 * Its receipts are stored and shown as "mock"; a live failure never switches to it.
 */
function extractionAgentFromEnv(): NvidiaExtractionAgent {
  const mode = process.env.DISPATCH_EXTRACTION ?? 'live';
  if (mode === 'mock') return NvidiaExtractionAgent.createWithMock();
  if (mode !== 'live')
    throw new Error(`DISPATCH_EXTRACTION must be "live" or "mock", got "${mode}".`);
  return new NvidiaExtractionAgent();
}

export class StateStore {
  public readonly clock = new FrozenClock(FROZEN_SCENARIO_TIME_ISO);
  public readonly appDb: AppDatabase;
  public readonly sources: SourceGateway;
  public readonly recoveryService: RecoveryService;
  public investigationService: InvestigationService;
  private readonly evidenceDir: string | undefined;
  private readonly dataDir: string;
  /** The configured extraction model, shown before any investigation has run. */
  public extraction: { mode: 'live' | 'mock'; model: string } = { mode: 'live', model: '' };
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private readonly executionLimits: ExecutionLimits;

  constructor(options: StateStoreOptions = {}) {
    this.executionLimits = ExecutionLimitsSchema.parse(
      options.executionLimits ?? {
        maxCalls:
          process.env.DISPATCH_MAX_MODEL_CALLS === undefined
            ? undefined
            : Number(process.env.DISPATCH_MAX_MODEL_CALLS),
        maxTokens:
          process.env.DISPATCH_MAX_MODEL_TOKENS === undefined
            ? undefined
            : Number(process.env.DISPATCH_MAX_MODEL_TOKENS),
        workflowTimeoutMs:
          process.env.DISPATCH_WORKFLOW_TIMEOUT_MS === undefined
            ? undefined
            : Number(process.env.DISPATCH_WORKFLOW_TIMEOUT_MS)
      }
    );
    const dataDir =
      options.dataDir ?? process.env.DISPATCH_DATA_DIR ?? path.join(process.cwd(), 'data');
    this.evidenceDir =
      options.evidenceDir === null
        ? undefined
        : (options.evidenceDir ??
          process.env.DISPATCH_EVIDENCE_DIR ??
          path.join(process.cwd(), '.local/evidence'));
    this.dataDir = dataDir;
    this.appDb = new AppDatabase(path.join(dataDir, 'dispatch_app.sqlite'));
    this.sources = options.sources ?? createSourceGateway(dataDir);
    this.recoveryService = new RecoveryService(this.clock, new RecoveryStore(this.appDb));
    this.investigationService = this.buildInvestigationService(
      options.extractionAgent ?? extractionAgentFromEnv()
    );
  }

  /** Swaps the model client, e.g. an explicitly labelled mock in tests. */
  useExtractionAgent(agent: NvidiaExtractionAgent): void {
    this.investigationService = this.buildInvestigationService(agent);
  }

  /** Seeds the demo sources once. Existing source revisions survive server restarts. */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    this.initialization ??= this.initializeSources().catch((err) => {
      this.initialization = undefined;
      throw err;
    });
    return this.initialization;
  }

  private async initializeSources(): Promise<void> {
    if (!(await this.sources.isSeeded())) {
      await this.sources.seed(DEMO_SEED);
    }
    this.initialized = true;
  }

  /** Restores the synthetic baseline: source files and application history. */
  async resetDemo(): Promise<void> {
    this.appDb.clearDemoData();
    await this.sources.seed(DEMO_SEED);
    this.initialized = true;
  }

  /**
   * Compares the receipt's cited source revisions with the current sources and marks the plan
   * stale if any changed. Returns which sources changed.
   */
  async invalidateIfSourcesChanged(
    receiptId: string,
    actor?: UserSession,
    /** A snapshot the caller already read, so the sources are not read twice. */
    current?: EvidenceSnapshot
  ): Promise<{ invalidated: boolean; changedSources: string[] }> {
    const existing = this.recoveryService.getReceipt(receiptId);
    if (!existing) return { invalidated: false, changedSources: [] };

    const snapshot =
      current ?? (await this.sources.fetchEvidenceSnapshot(existing.orderId, this.clock.nowIso()));
    const check = this.recoveryService.checkAndInvalidateIfSourcesChanged(
      receiptId,
      snapshotToSourceRevisions(snapshot),
      actor
    );
    return { invalidated: check.invalidated, changedSources: check.changedSources };
  }

  private buildInvestigationService(agent: NvidiaExtractionAgent): InvestigationService {
    this.extraction = { mode: agent.isMockMode() ? 'mock' : 'live', model: agent.getModelName() };
    return new InvestigationService(
      this.sources,
      agent,
      this.recoveryService,
      this.clock,
      createDispatchScout({ dataDir: this.dataDir, modelId: agent.getModelName() }),
      this.evidenceDir,
      { limits: this.executionLimits }
    );
  }
}

const globalForState = global as unknown as { dispatchStateStore?: StateStore };

/** Opens the store on first use, so importing a route never touches the database. */
export function getStateStore(): StateStore {
  globalForState.dispatchStateStore ??= new StateStore();
  return globalForState.dispatchStateStore;
}
