'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { DecisionTile, OptionTile } from '@/src/components/ReceiptTiles';
import { EmptyPanel } from '@/src/components/app/EmptyPanel';

export default function OrderDecision() {
  const { state } = useDeskContext();
  if (!state) return null;
  if (!state.receipt) return <EmptyPanel title="No decision receipt yet." />;
  return (
    <div className="bento">
      <DecisionTile receipt={state.receipt} />
      <OptionTile receipt={state.receipt} availability={state.backupAvailability} />
    </div>
  );
}
