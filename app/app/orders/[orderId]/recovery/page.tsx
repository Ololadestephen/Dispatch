'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { RecoveryTile } from '@/src/components/RecoveryTile';
import { DotPanel } from '@/src/components/app/DotPanel';

export default function OrderRecovery() {
  const desk = useDeskContext();
  const { state, pending } = desk;
  if (!state) return null;
  const receipt = state.receipt;
  if (!state.approval) return <DotPanel title="Nothing approved yet." />;
  return (
    <div className="bento">
      <RecoveryTile
        state={state}
        busy={pending !== null}
        onConfirm={(input) =>
          receipt ? desk.confirm(receipt.receiptId, receipt.version, input) : Promise.resolve(false)
        }
      />
    </div>
  );
}
