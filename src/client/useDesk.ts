'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Toast, ToastKind } from '../components/bencho/ToastStack';
import type {
  ActivityResponse,
  ConfirmationInput,
  DeskState,
  OrderSummary,
  OrdersResponse,
  SourceChange,
  UserRole
} from './deskState';

interface ApiFailure {
  success: false;
  error: string;
  code: string;
}

async function send(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const failure = (await res.json().catch(() => null)) as ApiFailure | null;
    throw new Error(failure?.error ?? `Request failed (${res.status}).`);
  }
}

async function readFailure(res: Response, fallback: string): Promise<ApiFailure> {
  return (
    ((await res.json().catch(() => null)) as ApiFailure | null) ?? {
      success: false,
      error: `${fallback} (${res.status}).`,
      code: 'INTERNAL_ERROR'
    }
  );
}

export type DeskAction =
  | 'investigate'
  | 'approve'
  | 'confirm'
  | 'role'
  | 'revise'
  | 'reset'
  | 'world-match';

/** What a finished action announces. Silent actions (role switch) pass undefined. */
const DONE_TOAST: Partial<Record<DeskAction, { title: string; body: string }>> = {
  investigate: { title: 'Investigation saved', body: 'A new receipt version is ready to review.' },
  approve: { title: 'Plan approved', body: 'Tasks and an unsent supplier draft were created.' },
  confirm: { title: 'Confirmation recorded', body: 'Stored as a simulated supplier confirmation.' },
  revise: { title: 'Source revision saved', body: 'The plan was re-checked against it.' },
  reset: {
    title: 'Sample data reset',
    body: 'Sources and history are back to the starting point.'
  },
  'world-match': {
    title: 'Identity decision saved',
    body: 'The World Model review queue and audit history were updated.'
  }
};

const DEFAULT_ORDER_ID = 'DSP-1042';

/**
 * Loads the orders list plus the current order's desk state, and runs mutations.
 * One idempotency key is generated per (action, receipt version) and reused on retries,
 * so a double submit cannot act twice. Every mutation resolves true or false, and its
 * real outcome becomes a toast.
 */
export function useDesk() {
  const [state, setState] = useState<DeskState | null>(null);
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [activeOrderId, setActiveOrderId] = useState(DEFAULT_ORDER_ID);
  const [orderNotFound, setOrderNotFound] = useState<string | null>(null);
  const [pending, setPending] = useState<DeskAction | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const keys = useRef(new Map<string, string>());
  const nextToast = useRef(1);
  const activeOrder = useRef(DEFAULT_ORDER_ID);
  const requestSequence = useRef(0);

  const toast = useCallback((kind: ToastKind, title: string, body: string) => {
    const id = nextToast.current++;
    setToasts((t) => [{ id, kind, title, body }, ...t]);
    // Successes clear themselves; errors stay until dismissed.
    if (kind === 'success') {
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    }
  }, []);

  /** Refreshes the active order and the orders list together, so status pills never drift. */
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    const target = activeOrder.current;
    const [stateRes, ordersRes] = await Promise.all([
      fetch(`/api/orders/${encodeURIComponent(target)}/state`, { cache: 'no-store' }),
      fetch('/api/orders', { cache: 'no-store' })
    ]);
    if (sequence !== requestSequence.current) return;

    if (ordersRes.ok) {
      setOrders(((await ordersRes.json()) as OrdersResponse).orders);
    }
    if (stateRes.status === 404) {
      const failure = await readFailure(stateRes, 'Order not found');
      setState(null);
      setOrderNotFound(target);
      setLoadError(failure.error);
      return;
    }
    if (!stateRes.ok) {
      throw new Error((await readFailure(stateRes, 'Could not load the order')).error);
    }
    setState((await stateRes.json()) as DeskState);
    setOrderNotFound(null);
    setLoadError(null);
  }, []);

  const loadOrder = useCallback(
    async (orderId: string) => {
      activeOrder.current = orderId;
      setActiveOrderId(orderId);
      setOrderNotFound((current) => (current === orderId ? null : current));
      await refresh().catch((err: Error) => setLoadError(err.message));
    },
    [refresh]
  );

  useEffect(() => {
    refresh().catch((err: Error) => setLoadError(err.message));
  }, [refresh]);

  const run = useCallback(
    async (action: DeskAction, path: string, body: unknown): Promise<boolean> => {
      setPending(action);
      let ok = false;
      try {
        await send(path, body);
        ok = true;
        const done = DONE_TOAST[action];
        if (done) toast('success', done.title, done.body);
      } catch (err) {
        toast('error', 'Not done', (err as Error).message);
      } finally {
        await refresh().catch((err: Error) => setLoadError(err.message));
        setPending(null);
      }
      return ok;
    },
    [refresh, toast]
  );

  const keyFor = (action: string, receiptId: string, version: number) => {
    const scope = `${action}:${receiptId}:v${version}`;
    let key = keys.current.get(scope);
    if (!key) {
      key = crypto.randomUUID();
      keys.current.set(scope, key);
    }
    return key;
  };

  const loadActivity = useCallback(async (): Promise<ActivityResponse> => {
    const res = await fetch('/api/activity', { cache: 'no-store' });
    if (!res.ok) throw new Error((await readFailure(res, 'Could not load activity')).error);
    return (await res.json()) as ActivityResponse;
  }, []);

  return {
    state,
    orders,
    activeOrderId,
    orderNotFound,
    pending,
    loadError,
    toasts,
    dismissToast: (id: number) => setToasts((t) => t.filter((x) => x.id !== id)),
    refresh: () => refresh().catch((err: Error) => setLoadError(err.message)),
    loadOrder,
    loadActivity,
    investigate: (orderId: string) => run('investigate', '/api/investigate', { orderId }),
    approve: (receiptId: string, version: number) =>
      run('approve', '/api/approve', {
        receiptId,
        expectedVersion: version,
        idempotencyKey: keyFor('approve', receiptId, version)
      }),
    confirm: (receiptId: string, version: number, input: ConfirmationInput) =>
      run('confirm', '/api/confirm', {
        receiptId,
        expectedVersion: version,
        idempotencyKey: keyFor('confirm', receiptId, version),
        ...input
      }),
    switchRole: (role: UserRole) => run('role', '/api/role', { role }),
    reviseSource: (orderId: string, change: SourceChange) =>
      run('revise', '/api/sources/revise', { orderId, change }),
    resolveWorldMatch: (proposalId: string, decision: 'approve' | 'reject') =>
      run('world-match', '/api/world-model/merge', { proposalId, decision }),
    reset: () => run('reset', '/api/reset', { confirmReset: true })
  };
}

export type Desk = ReturnType<typeof useDesk>;
