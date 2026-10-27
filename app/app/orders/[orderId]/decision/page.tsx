'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { DecisionTile, OptionTile } from '@/src/components/ReceiptTiles';
import { DotPanel } from '@/src/components/app/DotPanel';

export default function OrderDecision() {
  const { state } = useDeskContext();
  if (!state) return null;
  if (!state.receipt) return <DotPanel title="No decision receipt yet." />;
  return (
    <div className="bento">
      <DecisionTile receipt={state.receipt} />
      <OptionTile receipt={state.receipt} availability={state.backupAvailability} />
    </div>
  );
}
