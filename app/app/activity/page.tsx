'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { HistoryTile } from '@/src/components/SourceTiles';
import { DotPanel } from '@/src/components/app/DotPanel';

export default function ActivityPage() {
  const { state } = useDeskContext();
  if (!state) return null;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Activity</h1>
      </div>
      {state.auditEvents.length ? (
        <div className="bento">
          <HistoryTile state={state} />
        </div>
      ) : (
        <DotPanel title="No activity yet." />
      )}
    </>
  );
}
