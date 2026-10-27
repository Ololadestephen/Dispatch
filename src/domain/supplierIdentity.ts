import type { DecisionReceipt } from './receipt';

/** Only aliases in this receipt's approved identity snapshot may confirm its exact backup lot. */
export function supplierMatchesPlan(receipt: DecisionReceipt, name: string): boolean {
  const candidate = receipt.candidateRemedy;
  if (!candidate) return false;
  if (name === candidate.supplierName) return true;
  return (
    receipt.worldModel?.resolvedSuppliers.some(
      (supplier) =>
        supplier.status === 'merged' &&
        supplier.names.includes(name) &&
        supplier.names.includes(candidate.supplierName) &&
        supplier.sourceRecords.some(
          (record) =>
            record.sourceType === 'backup_listings' &&
            record.recordId === candidate.listingId &&
            record.revisionId === candidate.revisionId
        )
    ) ?? false
  );
}
