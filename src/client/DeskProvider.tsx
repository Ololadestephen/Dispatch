'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { useDesk, type Desk } from './useDesk';
import type { AnySourceEnvelope, DeskState } from './deskState';
import { EvidenceDrawer, type HighlightSpan } from '../components/EvidenceDrawer';
import { ToastStack } from '../components/bencho/ToastStack';
import '../components/bencho/ToastStack.css';

interface DeskContextValue extends Desk {
  openSource: (envelope: AnySourceEnvelope) => void;
}

const DeskContext = createContext<DeskContextValue | null>(null);

/** One desk state for every app page, so moving between pages never refetches or loses toasts. */
export function DeskProvider({ children }: { children: ReactNode }) {
  const desk = useDesk();
  const [drawer, setDrawer] = useState<AnySourceEnvelope | null>(null);

  return (
    <DeskContext.Provider value={{ ...desk, openSource: setDrawer }}>
      {children}
      <div className="toasts">
        <ToastStack toasts={desk.toasts} onDismiss={desk.dismissToast} />
      </div>
      {drawer && desk.state && (
        <EvidenceDrawer
          envelope={drawer}
          spans={supplierSpans(desk.state, drawer)}
          onClose={() => setDrawer(null)}
        />
      )}
    </DeskContext.Provider>
  );
}

export function useDeskContext(): DeskContextValue {
  const value = useContext(DeskContext);
  if (!value) throw new Error('useDeskContext must be used inside DeskProvider.');
  return value;
}

/** Highlight spans apply only to the exact supplier revision the receipt read. */
function supplierSpans(state: DeskState, drawer: AnySourceEnvelope): HighlightSpan[] {
  const receipt = state.receipt;
  const sameRevision =
    receipt?.sourceRevisions.some(
      (s) => s.revisionId === state.sources.supplierUpdates.revisionId
    ) ?? false;
  if (drawer.sourceType !== 'supplier_updates' || !sameRevision || !receipt) return [];
  return [
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
  ];
}
