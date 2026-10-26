'use client';

import { useState } from 'react';
import { useDesk } from '@/src/client/useDesk';
import type { AnySourceEnvelope } from '@/src/client/deskState';
import { TopBar } from '@/src/components/TopBar';
import { Hero } from '@/src/components/Hero';
import { IntegrationStrip } from '@/src/components/IntegrationStrip';
import {
  DecisionTile,
  LookupsTile,
  OptionTile,
  SupplierMessageTile
} from '@/src/components/ReceiptTiles';
import { RecoveryTile } from '@/src/components/RecoveryTile';
import { HistoryTile, SourcesTile } from '@/src/components/SourceTiles';
import { EvidenceDrawer, HighlightSpan } from '@/src/components/EvidenceDrawer';
import { ToastStack } from '@/src/components/bencho/ToastStack';
import '@/src/components/bencho/ToastStack.css';

export default function DispatchDesk() {
  const desk = useDesk();
  const [drawer, setDrawer] = useState<AnySourceEnvelope | null>(null);
  const { state, pending } = desk;
  const busy = pending !== null;

  if (!state) {
    return (
      <main className="loading" aria-busy={!desk.loadError}>
        {desk.loadError ? (
          <>
            <p className="pill pill-risk" role="alert">
              {desk.loadError}
            </p>
            <button className="btn" onClick={() => void desk.refresh()}>
              Refresh
            </button>
          </>
        ) : (
          <p>Loading…</p>
        )}
      </main>
    );
  }

  const { receipt } = state;
  const orderId = state.sources.orders.data.orderId;
  const sameSupplierRevision =
    receipt?.sourceRevisions.some(
      (s) => s.revisionId === state.sources.supplierUpdates.revisionId
    ) ?? false;
  const drawerSpans: HighlightSpan[] =
    drawer?.sourceType === 'supplier_updates' && sameSupplierRevision && receipt
      ? [
          ...receipt.agentFindings.extractedQuotes.flatMap((q) =>
            q.startIndex !== undefined && q.endIndex !== undefined
              ? [{ startIndex: q.startIndex, endIndex: q.endIndex, kind: 'quote' as const }]
              : []
          ),
          ...(receipt.agentFindings.ignoredInstructionSpans ?? []).map((s) => ({
            startIndex: s.startIndex,
            endIndex: s.endIndex,
            kind: 'ignored' as const
          }))
        ]
      : [];

  return (
    <>
      <TopBar state={state} busy={busy} onRole={desk.switchRole} onReset={desk.reset} />
      <main className="page" aria-busy={busy}>
        {desk.loadError && (
          <div className="row" role="alert">
            <span className="pill pill-risk">{desk.loadError}</span>
            <button className="btn" disabled={busy} onClick={() => void desk.refresh()}>
              Refresh
            </button>
          </div>
        )}
        <Hero
          state={state}
          busy={busy}
          investigating={pending === 'investigate'}
          onInvestigate={() => desk.investigate(orderId)}
          onApprove={() =>
            receipt ? desk.approve(receipt.receiptId, receipt.version) : Promise.resolve(false)
          }
          onGoToConfirmation={() =>
            document.getElementById('recovery')?.scrollIntoView({ behavior: 'smooth' })
          }
        />
        <IntegrationStrip state={state} />

        <div className="bento">
          {receipt && <DecisionTile receipt={receipt} />}
          {receipt && <OptionTile receipt={receipt} />}
          {receipt && <LookupsTile receipt={receipt} />}
          <SupplierMessageTile state={state} />
          <RecoveryTile
            state={state}
            busy={busy}
            onConfirm={(input) =>
              receipt
                ? desk.confirm(receipt.receiptId, receipt.version, input)
                : Promise.resolve(false)
            }
          />
          <SourcesTile state={state} busy={busy} onOpen={setDrawer} onRevise={desk.reviseSource} />
          <HistoryTile state={state} />
        </div>
      </main>

      <div className="toasts">
        <ToastStack toasts={desk.toasts} onDismiss={desk.dismissToast} />
      </div>

      {drawer && (
        <EvidenceDrawer envelope={drawer} spans={drawerSpans} onClose={() => setDrawer(null)} />
      )}
    </>
  );
}
