import type { InvestigationStep } from '../domain/receipt';
import { DomainError } from '../domain/errors';
import { calculateUsableStock } from '../domain/stock';
import { backupUnitsRequired } from '../domain/shortfall';
import { ModelLookupRequestsSchema } from '../domain/lookupRequest';
import type { SourceGateway } from '../integrations/sources/gateway';
import type { AllowlistedLookupExecution } from '../integrations/sources/types';
import type {
  SyntheticBackupListingRecord,
  SyntheticInboundShipmentRecord,
  SyntheticOrderRecord,
  SyntheticSupplierUpdateRecord,
  SyntheticWarehouseRecord
} from '../demo/seedData';
import { LOOKUP_TOOLS, LookupCapability } from '../integrations/meterless/dispatchScout';
import {
  ContractRefusedError,
  type ExecutionContract,
  type Scout
} from '../integrations/meterless/scout';

/** Each lookup's full result by capability, so the evidence snapshot reuses it. */
export interface LookupResults {
  'orders.read'?: AllowlistedLookupExecution<SyntheticOrderRecord>;
  'inventory.read'?: AllowlistedLookupExecution<SyntheticWarehouseRecord>;
  'inbound.read'?: AllowlistedLookupExecution<SyntheticInboundShipmentRecord>;
  'supplier_messages.read'?: AllowlistedLookupExecution<SyntheticSupplierUpdateRecord>;
  'backup_listings.read'?: AllowlistedLookupExecution<SyntheticBackupListingRecord>;
  'policy.read'?: AllowlistedLookupExecution;
}

export interface LookupTrace {
  contract: ExecutionContract;
  steps: InvestigationStep[];
  results: LookupResults;
}

function isLookupCapability(capability: string): capability is LookupCapability {
  return capability in LOOKUP_TOOLS;
}

/**
 * Executes a Scout execution contract's tool plan against the read-only sources.
 * Scout grants the allowed capabilities. A caller can select a subset for the initial
 * reads or a validated model follow-up; every step verifies signature, expiry and scope.
 * The order lookup runs first because the others need its SKU; the rest run concurrently.
 * Steps are recorded in plan order.
 */
export async function executeLookupContract(params: {
  scout: Scout;
  contract: ExecutionContract;
  orderId: string;
  timestampIso: string;
  sources: SourceGateway;
  capabilities?: LookupCapability[];
  previous?: LookupTrace;
  signal?: AbortSignal;
}): Promise<LookupTrace> {
  const { scout, contract, orderId, timestampIso, sources, previous, signal } = params;

  const verify = (capability: string) => {
    try {
      scout.verify(contract, capability);
    } catch (err) {
      if (err instanceof ContractRefusedError) {
        throw new DomainError(`Lookup refused: ${err.message}`, 'CONTRACT_REFUSED');
      }
      throw err;
    }
  };

  // The whole plan is checked against the contract before anything is read.
  const allowed = contract.toolPlan.map((step) => {
    verify(step.capability);
    if (!isLookupCapability(step.capability)) {
      throw new DomainError(`No lookup implements ${step.capability}.`, 'CONTRACT_REFUSED');
    }
    return step.capability;
  });
  const plan = params.capabilities ?? allowed;
  if (
    new Set(plan).size !== plan.length ||
    plan.some((capability) => !allowed.includes(capability) || previous?.results[capability])
  ) {
    throw new DomainError(
      'Lookup plan repeats a read or exceeds its Scout contract.',
      'CONTRACT_REFUSED'
    );
  }

  let sku = previous?.results['orders.read']?.envelope?.data.sku ?? 'UNKNOWN';

  /**
   * A backup only has to cover what local stock cannot. Using the whole order quantity would
   * reject a lot that is large enough for the real shortage, and would make shared-lot
   * reservations look tighter than they are.
   */
  const backupCriteria = () => {
    const order = results['orders.read']?.envelope?.data;
    if (!order) return undefined;
    const inventory = results['inventory.read']?.envelope?.data;
    const usable = inventory ? calculateUsableStock(inventory).usableAvailable : 0;
    return {
      deliveryDeadlineIso: order.deliveryDeadlineIso,
      shortfallQuantity: backupUnitsRequired(order.requiredQuantity, usable)
    };
  };

  const readers: { [K in LookupCapability]: () => Promise<NonNullable<LookupResults[K]>> } = {
    'orders.read': () => sources.lookupOrder(orderId, timestampIso, signal),
    'inventory.read': () => sources.lookupInventory(sku, timestampIso, signal),
    'inbound.read': () => sources.lookupInbound(sku, timestampIso, signal, orderId),
    'supplier_messages.read': () => sources.lookupSupplierMessages(orderId, timestampIso, signal),
    'backup_listings.read': () =>
      sources.lookupBackupListings(sku, timestampIso, signal, backupCriteria()),
    'policy.read': () => sources.lookupPolicy('emergency_spend')
  };
  const results: LookupResults = { ...previous?.results };
  const run = async <K extends LookupCapability>(capability: K): Promise<void> => {
    signal?.throwIfAborted();
    verify(capability); // again right before the read, so an expired contract stops it
    results[capability] = await readers[capability]();
    signal?.throwIfAborted();
  };

  if (plan.includes('orders.read')) {
    await run('orders.read');
    sku = results['orders.read']?.envelope?.data.sku ?? 'UNKNOWN';
  }
  // Backup ranking needs the SKU and local usable stock, so it runs after the other reads.
  await Promise.all(
    plan.filter((c) => c !== 'orders.read' && c !== 'backup_listings.read').map(run)
  );
  if (plan.includes('backup_listings.read')) await run('backup_listings.read');

  const steps: InvestigationStep[] = plan.map((capability, i) => {
    const result = results[capability]!;
    return {
      stepIndex: (previous?.steps.length ?? 0) + i + 1,
      tool: LOOKUP_TOOLS[capability],
      args: result.args,
      sourceId: result.sourceId,
      revisionId: result.revisionId,
      recordId: result.recordId,
      status: result.status,
      outcomeSummary: result.outcomeSummary,
      contractId: contract.contractId,
      selectedBy: previous ? 'model' : 'scout'
    };
  });
  return { contract, steps: [...(previous?.steps ?? []), ...steps], results };
}

/** Exactly one optional tool round, bound to the fetched order, never model-selected SQL or URLs. */
export async function executeModelLookups(params: {
  requests: unknown;
  trace: LookupTrace;
  scout: Scout;
  sources: SourceGateway;
  orderId: string;
  timestampIso: string;
  signal?: AbortSignal;
}): Promise<LookupTrace> {
  const parsed = ModelLookupRequestsSchema.safeParse(params.requests);
  const order = params.trace.results['orders.read']?.envelope?.data;
  if (
    !parsed.success ||
    !order ||
    order.orderId !== params.orderId ||
    parsed.data.some((request) => request.args.sku !== order.sku)
  ) {
    throw new DomainError(
      'Model lookup request is invalid or outside this order.',
      'INVALID_LOOKUP_REQUEST'
    );
  }
  const request = parsed.data[0];
  if (!request) return params.trace;
  const trace = await executeLookupContract({
    ...params,
    contract: params.trace.contract,
    previous: params.trace,
    capabilities: ['backup_listings.read']
  });
  const final = trace.steps[trace.steps.length - 1]!;
  final.selectionReason = request.reason;
  return trace;
}
