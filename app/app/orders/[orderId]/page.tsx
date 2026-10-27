'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { IntegrationStrip } from '@/src/components/IntegrationStrip';
import { SupplierMessageTile, OptionTile } from '@/src/components/ReceiptTiles';
import { EmptyPanel } from '@/src/components/app/EmptyPanel';

/** Keep the supplier evidence and recovery option beside the order summary. */
export default function OrderOverview() {
  const { state } = useDeskContext();
  if (!state) return null;
  return (
    <>
      <IntegrationStrip state={state} />
      {state.receipt ? (
        <div className="bento">
          <SupplierMessageTile state={state} className="span-7" />
          <OptionTile receipt={state.receipt} availability={state.backupAvailability} />
        </div>
      ) : (
        <EmptyPanel title="Not investigated yet." />
      )}
    </>
  );
}
