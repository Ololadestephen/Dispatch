'use client';

import { useDeskContext } from '@/src/client/DeskProvider';
import { IntegrationStrip } from '@/src/components/IntegrationStrip';
import { SourcesTile } from '@/src/components/SourceTiles';

export default function SourcesPage() {
  const desk = useDeskContext();
  const { state, pending } = desk;
  if (!state) return null;
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Sources</h1>
      </div>
      <IntegrationStrip state={state} />
      <div className="bento">
        <SourcesTile
          state={state}
          busy={pending !== null}
          onOpen={desk.openSource}
          onRevise={desk.reviseSource}
        />
      </div>
    </>
  );
}
