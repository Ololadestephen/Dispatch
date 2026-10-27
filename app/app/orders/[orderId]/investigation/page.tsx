'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { LookupsTile, SupplierMessageTile } from '@/src/components/ReceiptTiles';
import { WorldModelTile } from '@/src/components/WorldModelTiles';

export default function OrderInvestigation() {
  const { state } = useDeskContext();
  if (!state) return null;
  return (
    <div className="bento">
      {state.receipt && <LookupsTile receipt={state.receipt} />}
      <SupplierMessageTile state={state} />
      <WorldModelTile state={state} />
    </div>
  );
}
