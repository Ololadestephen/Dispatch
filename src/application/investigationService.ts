import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { SourceGateway } from '../integrations/sources/gateway';
import type {
  NvidiaExtractionAgent,
  ModelCallMetrics,
  ExtractionContext
} from '../integrations/nvidia/extractionAgent';
import { executeLookupContract, executeModelLookups, type LookupTrace } from './lookupPlan';
import type { Scout } from '../integrations/meterless/scout';
import {
  SUPPLIER_MESSAGE_SURFACE,
  type LookupCapability
} from '../integrations/meterless/dispatchScout';
import { RecoveryService } from './recoveryService';
import type { Clock } from '../domain/clock';
import { DomainError, ModelOutageError, UnresolvedQuoteError } from '../domain/errors';
import { calculateUsableStock } from '../domain/stock';
import type { UserSession } from '../domain/policy';
import { resolveExactSubstringSpan } from '../domain/arrivalParser';
import type { DecisionReceipt, IgnoredInstructionSpan, ScoutRecord } from '../domain/receipt';
import {
  ExecutionLimitsSchema,
  MAX_SUPPLIER_TEXT_BYTES,
  type ExecutionLimits
} from '../domain/executionLimits';
import { ModelUsageLedger } from '../persistence/modelUsageLedger';
import { WorkflowDeadline } from './workflowDeadline';
import { buildInvestigationReceipt, type ExtractionOutcome } from './investigationReceipt';
import type { WorldModelService } from '../integrations/meterless/worldModel';
import { answerWorldContext } from './worldModelContext';

const INITIAL_CAPABILITIES: LookupCapability[] = [
  'orders.read',
  'inventory.read',
  'inbound.read',
  'supplier_messages.read',
  'policy.read'
];
const LOCKED_PLAN_STATUSES = new Set<DecisionReceipt['status']>([
  'approved',
  'awaiting_confirmation',
  'confirmed'
]);

export interface InvestigationRunResult {
  receipt: DecisionReceipt;
  evidenceSnapshotId: string;
  modelMetrics: ModelCallMetrics;
  lookupTrace: LookupTrace;
  evidenceSavedPath?: string;
}

export class InvestigationService {
  public readonly modelUsage: ModelUsageLedger;
  private readonly limits: ExecutionLimits;
  private readonly worldModel?: WorldModelService;

  constructor(
    private readonly sources: SourceGateway,
    private readonly extractionAgent: NvidiaExtractionAgent,
    private readonly recoveryService: RecoveryService,
    private readonly clock: Clock,
    private readonly scout: Scout,
    private readonly evidenceDir?: string,
    options: { limits?: Partial<ExecutionLimits>; worldModel?: WorldModelService } = {}
  ) {
    this.limits = ExecutionLimitsSchema.parse(options.limits ?? {});
    this.worldModel = options.worldModel;
    this.modelUsage = new ModelUsageLedger(recoveryService.database, this.limits);
  }

  /** One model call and at most one optional lookup round. Timeout/cancellation forbids receipt writes. */
  async investigateOrder(
    orderId: string,
    requestedBy: UserSession,
    options: { signal?: AbortSignal } = {}
  ): Promise<InvestigationRunResult> {
    const deadline = new WorkflowDeadline(this.limits.workflowTimeoutMs, options.signal);
    try {
      return await deadline.run(() => this.investigate(orderId, requestedBy, deadline));
    } finally {
      deadline.dispose();
    }
  }

  private async investigate(
    orderId: string,
    requestedBy: UserSession,
    deadline: WorkflowDeadline
  ): Promise<InvestigationRunResult> {
    const nowIso = this.clock.nowIso();
    const current = this.recoveryService.getReceipt(`RCP-${orderId}-01`);
    if (current && LOCKED_PLAN_STATUSES.has(current.status)) {
      throw new DomainError(
        `Plan v${current.version} is ${current.status}; it can only be replaced after its sources change.`,
        'INVALID_STATE_TRANSITION'
      );
    }
    const runId = crypto.randomUUID();
    const decision = await deadline.run(() =>
      this.scout.decide({
        prompt: `Investigate order ${orderId}`,
        user: { id: requestedBy.userId, role: requestedBy.role },
        surface: 'desk'
      })
    );
    if (!decision.executionContract || decision.intent !== 'order.investigate') {
      throw new DomainError(
        `Scout issued no investigation contract (intent ${decision.intent}, risk ${decision.risk.level}).`,
        'SCOUT_REFUSED'
      );
    }
    const contract = decision.executionContract;
    let trace = await deadline.run((signal) =>
      executeLookupContract({
        scout: this.scout,
        contract,
        orderId,
        timestampIso: nowIso,
        sources: this.sources,
        capabilities: INITIAL_CAPABILITIES,
        signal
      })
    );
    const snapshot = () => {
      const results = trace.results;
      if (
        !results['orders.read'] ||
        !results['inventory.read'] ||
        !results['supplier_messages.read'] ||
        !results['policy.read']?.policy
      ) {
        throw new DomainError(
          'Scout did not authorize the required order, stock, supplier and policy reads.',
          'CONTRACT_REFUSED'
        );
      }
      return this.sources.snapshotFromLookups(orderId, nowIso, {
        order: results['orders.read'],
        inventory: results['inventory.read'],
        inbound: results['inbound.read'],
        supplier: results['supplier_messages.read'],
        backup: results['backup_listings.read']
      });
    };
    const initial = snapshot();
    const order = initial.sources.orders.data;
    if (order.orderId !== orderId)
      throw new DomainError('Source order does not match the requested order.', 'CONTRACT_REFUSED');
    const supplier = initial.sources.supplierUpdates.data;
    if (Buffer.byteLength(supplier.rawMessageText, 'utf8') > MAX_SUPPLIER_TEXT_BYTES) {
      throw new DomainError(
        'Supplier message exceeds the investigation input limit.',
        'INVALID_REQUEST'
      );
    }
    const stock = calculateUsableStock(initial.sources.inventory.data);
    const screen = await deadline.run(() =>
      this.scout.decide({
        prompt: supplier.rawMessageText,
        user: { id: `supplier:${supplier.messageId}`, role: 'external' },
        surface: SUPPLIER_MESSAGE_SURFACE
      })
    );
    const injectionFlags = screen.risk.flags.filter((flag) => flag.layer === 'injection');
    const scoutSpans: IgnoredInstructionSpan[] = injectionFlags.flatMap((flag) =>
      flag.evidence.map((text) => ({
        ...resolveExactSubstringSpan(
          supplier.rawMessageText,
          text,
          supplier.messageId,
          'ignoredInstruction'
        ),
        detectedBy: ['scout' as const]
      }))
    );
    const scout: ScoutRecord = {
      contractId: contract.contractId,
      traceId: contract.traceId,
      intent: contract.intent.primary.id,
      confidence: contract.intent.confidence,
      band: decision.band,
      capabilities: contract.scope.capabilities,
      issuedAt: contract.issuedAt,
      expiresAt: contract.expiresAt,
      registryVersion: contract.registryVersion,
      policyPackVersion: contract.policyPackVersion,
      supplierScreen: {
        level: screen.risk.level,
        flags: injectionFlags.map((flag) => ({
          kind: flag.kind,
          reason: flag.reason,
          evidence: flag.evidence
        }))
      }
    };
    const outcome = await this.extract({
      runId,
      orderId,
      requestedBy,
      deadline,
      supplierText: supplier.rawMessageText,
      recordId: supplier.messageId,
      order: {
        orderId,
        sku: order.sku,
        requiredQuantity: order.requiredQuantity,
        usableStock: stock.usableAvailable,
        deliveryDeadlineIso: order.deliveryDeadlineIso,
        scenarioClockIso: nowIso,
        needsSupplyReview: stock.usableAvailable < order.requiredQuantity
      }
    });
    if (outcome.ok) {
      trace = await deadline.run((signal) =>
        executeModelLookups({
          requests: outcome.bundle.extraction.lookupRequests,
          trace,
          scout: this.scout,
          sources: this.sources,
          orderId,
          timestampIso: nowIso,
          signal
        })
      );
    }
    const evidence = snapshot();
    const reservations = this.recoveryService.listReservations();
    const worldReference = this.worldModel
      ? await answerWorldContext({
          world: this.worldModel,
          scout: this.scout,
          trace,
          snapshot: evidence,
          reservations
        })
      : undefined;
    const receipt = buildInvestigationReceipt({
      snapshot: evidence,
      trace,
      scout,
      scoutSpans,
      outcome,
      clock: this.clock,
      version: (current?.version ?? 0) + 1,
      worldModel: worldReference
    });
    const metrics = outcome.ok ? outcome.bundle.metrics : outcome.metrics;
    deadline.check();
    const savedPath = this.persistEvidenceArtifact(orderId, {
      snapshot: evidence,
      receipt,
      metrics,
      lookupTrace: trace
    });
    deadline.check();
    this.recoveryService.saveReceipt(receipt, requestedBy, () => deadline.check());
    return {
      receipt,
      evidenceSnapshotId: evidence.snapshotId,
      modelMetrics: metrics,
      lookupTrace: trace,
      evidenceSavedPath: savedPath
    };
  }

  private async extract(input: {
    runId: string;
    orderId: string;
    requestedBy: UserSession;
    deadline: WorkflowDeadline;
    supplierText: string;
    recordId: string;
    order: NonNullable<ExtractionContext['order']>;
  }): Promise<ExtractionOutcome> {
    let attemptId: string | undefined;
    let reportedTokens: number | undefined;
    let settled = false;
    const settle = (status: 'succeeded' | 'failed', errorCode?: string) => {
      if (!attemptId || settled) return;
      settled = true;
      this.modelUsage.finish(attemptId, { status, reportedTokens, errorCode });
    };
    const started = performance.now();
    try {
      const bundle = await input.deadline.run((signal) =>
        this.extractionAgent.extractSupplierFindings(input.supplierText, input.recordId, {
          signal,
          order: input.order,
          beforeRequest: () => {
            input.deadline.check();
            attemptId = this.modelUsage.reserve({
              runId: input.runId,
              orderId: input.orderId,
              actorUserId: input.requestedBy.userId,
              model: this.extractionAgent.getModelName()
            });
            input.deadline.check();
          },
          onReportedUsage: (tokens) => {
            reportedTokens = tokens;
          }
        })
      );
      settle('succeeded');
      return { ok: true, bundle: { ...bundle, metrics: { ...bundle.metrics, attemptId } } };
    } catch (error) {
      settle('failed', error instanceof DomainError ? error.code : 'INTERNAL_ERROR');
      input.deadline.check();
      if (
        !(error instanceof ModelOutageError) &&
        !(error instanceof UnresolvedQuoteError) &&
        !(error instanceof ZodError)
      )
        throw error;
      return {
        ok: false,
        error,
        metrics: {
          model: this.extractionAgent.getModelName(),
          latencyMs: Math.round(performance.now() - started),
          isLiveCall: Boolean(attemptId),
          executionMode: 'incomplete',
          totalTokens: reportedTokens,
          attemptId
        }
      };
    }
  }

  private persistEvidenceArtifact(
    orderId: string,
    payload: { receipt: DecisionReceipt } & Record<string, unknown>
  ): string | undefined {
    if (!this.evidenceDir) return undefined;
    fs.mkdirSync(this.evidenceDir, { recursive: true });
    const mode = payload.receipt.executionMode ?? 'unknown';
    const savedPath = path.join(
      this.evidenceDir,
      `run_${orderId}_${mode}_${crypto.randomUUID()}.json`
    );
    fs.writeFileSync(savedPath, JSON.stringify(payload, null, 2), 'utf8');
    return savedPath;
  }
}
