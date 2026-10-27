import type { WorldModelReference } from '../domain/worldModel';
import { DomainError } from '../domain/errors';
import type { EvidenceSnapshot } from '../integrations/sources/types';
import type { BackupReservationRecord } from '../domain/reservation';
import type { WorldModelService } from '../integrations/meterless/worldModel';
import { ContractRefusedError, type Scout } from '../integrations/meterless/scout';
import type { LookupTrace } from './lookupPlan';

/** The verified Scout read plan bounds a query over records already mirrored by Dispatch. */
export async function answerWorldContext(input: {
  world: WorldModelService;
  scout: Scout;
  trace: LookupTrace;
  snapshot: EvidenceSnapshot;
  reservations: BackupReservationRecord[];
}): Promise<WorldModelReference> {
  const { world, scout, trace, snapshot, reservations } = input;
  const capabilities = [
    ...new Set(
      trace.steps
        .filter((step) => step.status === 'ok')
        .map((step) => trace.contract.toolPlan.find((tool) => tool.tool === step.tool)?.capability)
    )
  ].filter((capability): capability is string => Boolean(capability));
  // Verify the signature and expiry again after extraction; cached context cannot bypass Scout.
  try {
    scout.verify(trace.contract, 'orders.read');
    for (const capability of capabilities) scout.verify(trace.contract, capability);
  } catch (error) {
    if (error instanceof ContractRefusedError) {
      throw new DomainError(`World Model context refused: ${error.message}`, 'CONTRACT_REFUSED');
    }
    throw error;
  }
  const relations = ['requires'];
  if (capabilities.includes('inventory.read')) relations.push('stocks');
  if (capabilities.includes('inbound.read') || capabilities.includes('supplier_messages.read')) {
    relations.push('supplies');
  }
  if (capabilities.includes('backup_listings.read')) relations.push('offers', 'reserves');
  const result = await world.ingestSnapshot(snapshot, reservations);
  const limit = 24;
  const neighbours =
    result.context?.neighbours
      .filter((neighbour) => relations.includes(neighbour.via))
      .slice(0, limit - 1) ?? [];
  return {
    ...result.reference,
    contextQuery: {
      contractId: trace.contract.contractId,
      subjectEntityId: result.reference.contextEntityId,
      relations,
      limit,
      entityIds: [
        result.reference.contextEntityId,
        ...neighbours.map((neighbour) => neighbour.entity.id)
      ]
    }
  };
}
