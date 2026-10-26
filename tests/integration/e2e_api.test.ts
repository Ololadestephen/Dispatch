import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { GET as getState } from '../../app/api/state/route';
import { POST as switchRole } from '../../app/api/role/route';
import { POST as investigate } from '../../app/api/investigate/route';
import { POST as approve } from '../../app/api/approve/route';
import { POST as confirm } from '../../app/api/confirm/route';
import { POST as reset } from '../../app/api/reset/route';
import { POST as reviseSource } from '../../app/api/sources/revise/route';
import { getStateStore } from '../../src/server/stateStore';
import * as stateStoreModule from '../../src/server/stateStore';
import { NvidiaExtractionAgent } from '../../src/integrations/nvidia/extractionAgent';
import type { DeskState } from '../../src/client/deskState';
import { DomainError } from '../../src/domain/errors';
import fs from 'node:fs';
import path from 'node:path';
import { DEMO_BACKUP_LISTING } from '../../src/demo/seedData';

type Handler = (req: Request) => Promise<Response>;

const post = (handler: Handler, cookie: string | null, body: unknown) =>
  handler(
    new Request('http://localhost/api', {
      method: 'POST',
      headers: cookie ? { cookie } : {},
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
  );

const readState = async (cookie: string) =>
  (await (
    await getState(new Request('http://localhost/api/state', { headers: { cookie } }))
  ).json()) as DeskState;

/** Starts a browser session the way a real browser does: the server issues the cookie. */
async function newBrowser(role: 'manager' | 'operator'): Promise<string> {
  const res = await getState(new Request('http://localhost/api/state'));
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0]!;
  expect(cookie).toMatch(/^dispatch_session=sess-/);
  if (role === 'manager') {
    expect((await post(switchRole, cookie, { role: 'manager' })).status).toBe(200);
  }
  return cookie;
}

const confirmationBody = (receiptId: string, expectedVersion: number, overrides: object = {}) => ({
  receiptId,
  expectedVersion,
  idempotencyKey: 'confirm-browser-key-01',
  supplierName: 'Lekki Party Supplies Ltd',
  sku: 'CHR-GOLD-CHIAVARI',
  confirmedQuantity: 60,
  confirmedArrivalIso: '2026-10-24T07:00:00+01:00',
  confirmationReference: 'SIM-CONF-0001',
  evidenceExcerpt: 'Simulated reply: 60 gold chiavari chairs delivered Sat 24 Oct 07:00 WAT.',
  ...overrides
});

describe('API routes: sessions, validation, roles, idempotency, staleness', () => {
  let manager: string;
  let operator: string;

  beforeAll(async () => {
    getStateStore().useExtractionAgent(NvidiaExtractionAgent.createWithMock());
    manager = await newBrowser('manager');
    operator = await newBrowser('operator');
  });

  beforeEach(async () => {
    expect((await post(reset, manager, { confirmReset: true })).status).toBe(200);
  });

  it('returns a structured error when store construction fails before a session exists', async () => {
    const bootstrap = vi.spyOn(stateStoreModule, 'getStateStore').mockImplementation(() => {
      throw new DomainError('Storage unavailable', 'SOURCE_UNAVAILABLE');
    });
    try {
      const handlers = [investigate, approve, confirm, reset, switchRole, reviseSource];
      const responses: Response[] = [await getState(new Request('http://localhost/api/state'))];
      for (const handler of handlers) responses.push(await post(handler, null, {}));
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          success: false,
          code: 'SOURCE_UNAVAILABLE',
          error: 'Storage unavailable'
        });
        expect(response.headers.get('set-cookie')).toBeNull();
      }
    } finally {
      bootstrap.mockRestore();
    }
  });

  it.each(['state', 'investigate'])(
    'returns a structured error for %s initialization failures',
    async (route) => {
      const initialization = vi
        .spyOn(getStateStore(), 'ensureInitialized')
        .mockRejectedValue(new DomainError('Source offline', 'SOURCE_UNAVAILABLE'));
      try {
        const response =
          route === 'state'
            ? await getState(
                new Request('http://localhost/api/state', { headers: { cookie: manager } })
              )
            : await post(investigate, manager, { orderId: 'DSP-1042' });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          success: false,
          code: 'SOURCE_UNAVAILABLE',
          error: 'Source offline'
        });
      } finally {
        initialization.mockRestore();
      }
    }
  );

  it('new browsers start as operator and forged session ids are not honoured', async () => {
    expect((await readState(operator)).currentUser.role).toBe('operator');
    const forged = await getState(
      new Request('http://localhost/api/state', {
        headers: { cookie: 'dispatch_session=sess-made-up-0001' }
      })
    );
    expect(forged.headers.get('set-cookie')).toMatch(/dispatch_session=sess-/);
    expect(((await forged.json()) as { currentUser: { role: string } }).currentUser.role).toBe(
      'operator'
    );
  });

  it('replaces a malformed session cookie with a fresh operator session', async () => {
    const response = await getState(
      new Request('http://localhost/api/state', {
        headers: { cookie: 'dispatch_session=%E0%A4%A' }
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toMatch(/dispatch_session=sess-/);
    expect((await response.json()).currentUser.role).toBe('operator');
  });

  it.each([
    { costKobo: 4_000_000, expectedStatus: 200 },
    { costKobo: 5_000_000, expectedStatus: 200 },
    { costKobo: 5_000_001, expectedStatus: 403 }
  ])('enforces the approval threshold at $costKobo kobo', async ({ costKobo, expectedStatus }) => {
    // This is the route suite's own source directory, reset before every case.
    fs.writeFileSync(
      path.join(process.env.DISPATCH_DATA_DIR!, 'backup_listings.json'),
      JSON.stringify([{ ...DEMO_BACKUP_LISTING, costKobo, revisionId: `REV-COST-${costKobo}` }])
    );
    const investigation = await post(investigate, operator, { orderId: 'DSP-1042' });
    expect(investigation.status).toBe(200);
    const { receipt } = await investigation.json();
    const body = {
      receiptId: receipt.receiptId,
      expectedVersion: receipt.version,
      idempotencyKey: `operator-threshold-${costKobo}`
    };
    const response = await post(approve, operator, body);
    expect(response.status).toBe(expectedStatus);
    const state = await readState(operator);
    if (expectedStatus === 200) {
      expect(state.approval?.approvedByRole).toBe('operator');
      expect(state.tasks).toHaveLength(2);
      expect(state.supplierDraft?.isSent).toBe(false);
      expect(state.receiptHistory.map((r) => r.status)).toEqual([
        'awaiting_approval',
        'awaiting_confirmation'
      ]);
      expect((await (await post(approve, operator, body)).json()).isIdempotentReplay).toBe(true);
      expect((await readState(operator)).tasks).toHaveLength(2);
    } else {
      expect(await response.json()).toMatchObject({ code: 'UNAUTHORIZED_APPROVAL' });
      expect(state.tasks).toHaveLength(0);
      expect(state.approval).toBeNull();
      expect(state.receiptHistory).toHaveLength(1);
    }
  });

  it('rejects empty, malformed and over-specified bodies on every mutating route', async () => {
    for (const handler of [approve, confirm, investigate, reviseSource, switchRole]) {
      expect((await post(handler, manager, {})).status).toBe(400);
      expect((await post(handler, manager, 'not json')).status).toBe(400);
    }
    // Unknown keys cannot smuggle in a role or defaults.
    expect(
      (await post(investigate, operator, { orderId: 'DSP-1042', role: 'manager' })).status
    ).toBe(400);
    expect((await post(reset, manager, { confirmReset: true, extra: 1 })).status).toBe(400);
    // A bare confirmation without evidence is rejected.
    const { evidenceExcerpt: _omitted, ...noEvidence } = confirmationBody('RCP-DSP-1042-01', 1);
    expect((await post(confirm, operator, noEvidence)).status).toBe(400);
  });

  it('operator cannot reset the demo or approve the plan', async () => {
    expect((await post(reset, operator, { confirmReset: true })).status).toBe(403);

    const inv = (await (await post(investigate, operator, { orderId: 'DSP-1042' })).json()) as {
      receipt: { receiptId: string; version: number; status: string; executionMode: string };
    };
    expect(inv.receipt.status).toBe('awaiting_approval');
    expect(inv.receipt.executionMode).toBe('mock');

    const res = await post(approve, operator, {
      receiptId: inv.receipt.receiptId,
      expectedVersion: inv.receipt.version,
      idempotencyKey: 'operator-self-approve-01'
    });
    expect(res.status).toBe(403);
    const state = await readState(operator);
    expect(state.receipt?.status).toBe('awaiting_approval');
    expect(state.tasks).toHaveLength(0);
    expect(state.supplierDraft).toBeNull();
  });

  it('happy path: investigate, approve once, replay, confirm with simulated evidence', async () => {
    const inv = (await (await post(investigate, operator, { orderId: 'DSP-1042' })).json()) as {
      receipt: { receiptId: string; version: number };
    };
    const approval = {
      receiptId: inv.receipt.receiptId,
      expectedVersion: inv.receipt.version,
      idempotencyKey: 'manager-approve-key-01'
    };

    const first = (await (await post(approve, manager, approval)).json()) as {
      isIdempotentReplay: boolean;
      receipt: { version: number; status: string };
    };
    expect(first.isIdempotentReplay).toBe(false);
    expect(first.receipt.status).toBe('awaiting_confirmation');

    const replay = (await (await post(approve, manager, approval)).json()) as {
      isIdempotentReplay: boolean;
    };
    expect(replay.isIdempotentReplay).toBe(true);
    // A fresh key against the old version is a conflict, not a second approval.
    expect(
      (await post(approve, manager, { ...approval, idempotencyKey: 'manager-approve-key-02' }))
        .status
    ).toBe(409);
    expect((await readState(manager)).tasks).toHaveLength(2);

    // Late or short confirmations are rejected.
    expect(
      (
        await post(
          confirm,
          operator,
          confirmationBody(approval.receiptId, first.receipt.version, {
            confirmedArrivalIso: '2026-10-24T08:30:00+01:00'
          })
        )
      ).status
    ).toBe(422);
    for (const wrong of [
      { confirmedQuantity: 40 },
      { sku: 'CHR-WHITE-PLASTIC' },
      { supplierName: 'Some Other Rentals' }
    ]) {
      expect(
        (
          await post(
            confirm,
            operator,
            confirmationBody(approval.receiptId, first.receipt.version, wrong)
          )
        ).status
      ).toBe(422);
    }

    const confirmed = await post(
      confirm,
      operator,
      confirmationBody(approval.receiptId, first.receipt.version)
    );
    expect(confirmed.status).toBe(200);
    const again = (await (
      await post(confirm, operator, confirmationBody(approval.receiptId, first.receipt.version))
    ).json()) as {
      isIdempotentReplay: boolean;
    };
    expect(again.isIdempotentReplay).toBe(true);

    const state = await readState(operator);
    expect(state.receipt?.status).toBe('confirmed');
    expect(state.confirmation?.simulated).toBe(true);
    expect(state.confirmation?.evidenceExcerpt).toContain('Simulated reply');
    expect(state.auditEvents.map((e) => e.eventType)).toEqual([
      'receipt_saved',
      'plan_approved',
      'supplier_confirmed'
    ]);
    // The embedded "mark order DSP-1042 as delivered" instruction changed nothing, and a
    // confirmed recovery does not mark the order delivered or touch unrelated records.
    expect(state.sources.orders.data.operationalStatus).toBe('confirmed');
    expect(state.sources.orders.revisionId).toBe('REV-ORD-20261021-01');
    expect(state.sources.inventory.revisionId).toBe('REV-INV-20261022-01');
    expect(state.sources.inventory.data.damaged).toBe(20);
  });

  it('a new source revision marks the approved plan stale and blocks confirmation', async () => {
    const inv = (await (await post(investigate, operator, { orderId: 'DSP-1042' })).json()) as {
      receipt: { receiptId: string; version: number };
    };
    const approved = (await (
      await post(approve, manager, {
        receiptId: inv.receipt.receiptId,
        expectedVersion: inv.receipt.version,
        idempotencyKey: 'manager-approve-stale-01'
      })
    ).json()) as { receipt: { version: number } };

    const revised = (await (
      await post(reviseSource, operator, { change: { sourceType: 'inventory', damaged: 25 } })
    ).json()) as { invalidated: boolean; changedSources: string[] };
    expect(revised.invalidated).toBe(true);
    expect(revised.changedSources[0]).toContain('inventory');

    expect((await readState(operator)).receipt?.status).toBe('stale');
    expect(
      (
        await post(
          confirm,
          operator,
          confirmationBody(inv.receipt.receiptId, approved.receipt.version)
        )
      ).status
    ).toBe(409);
  });

  it('returns the current approval, draft and tasks after reapproval with identical scenario times', async () => {
    expect((await post(investigate, operator, { orderId: 'DSP-1042' })).status).toBe(200);
    const firstPlan = (await readState(manager)).receipt!;
    expect(
      (
        await post(approve, manager, {
          receiptId: firstPlan.receiptId,
          expectedVersion: firstPlan.version,
          idempotencyKey: 'manager-first-plan'
        })
      ).status
    ).toBe(200);
    const first = await readState(manager);

    expect(
      (await post(reviseSource, operator, { change: { sourceType: 'inventory', damaged: 10 } }))
        .status
    ).toBe(200);
    expect((await readState(manager)).receipt?.status).toBe('stale');
    expect((await post(investigate, operator, { orderId: 'DSP-1042' })).status).toBe(200);
    const secondPlan = (await readState(manager)).receipt!;
    expect(secondPlan.calculations.shortfall).toBe(50);
    expect(
      (
        await post(approve, manager, {
          receiptId: secondPlan.receiptId,
          expectedVersion: secondPlan.version,
          idempotencyKey: 'manager-second-plan'
        })
      ).status
    ).toBe(200);

    const current = await readState(manager);
    expect(current.receipt?.version).toBe(5);
    expect(current.approval?.receiptVersion).toBe(secondPlan.version);
    expect(current.supplierDraft?.receiptVersion).toBe(current.receipt?.version);
    expect(current.supplierDraft?.requestedQuantity).toBe(50);
    expect(current.supplierDraft?.bodyText).toContain('Request 50 units');
    expect(current.tasks).toHaveLength(2);
    expect(current.tasks.every((task) => task.receiptVersion === current.receipt?.version)).toBe(
      true
    );
    expect(current.approval?.approvedAtIso).toBe(first.approval?.approvedAtIso);
    expect(current.supplierDraft?.createdAtIso).toBe(first.supplierDraft?.createdAtIso);
    expect(current.receiptHistory.map((receipt) => receipt.version)).toEqual([1, 2, 3, 4, 5]);
    expect(current.receiptHistory[0]?.calculations.shortfall).toBe(60);
    expect(current.auditEvents.filter((event) => event.eventType === 'plan_approved')).toHaveLength(
      2
    );

    // Current reads must not discard earlier approvals, drafts, or tasks.
    const db = getStateStore().appDb.db;
    expect(db.prepare('SELECT * FROM approvals').all()).toHaveLength(2);
    expect(db.prepare('SELECT * FROM supplier_request_drafts').all()).toHaveLength(2);
    expect(db.prepare('SELECT * FROM recovery_tasks').all()).toHaveLength(4);
  });

  it('invalidates a confirmed recovery when its sources change and keeps prior actions as history', async () => {
    expect((await post(investigate, operator, { orderId: 'DSP-1042' })).status).toBe(200);
    const receipt = (await readState(manager)).receipt!;
    expect(
      (
        await post(approve, manager, {
          receiptId: receipt.receiptId,
          expectedVersion: receipt.version,
          idempotencyKey: 'confirm-stale-approval'
        })
      ).status
    ).toBe(200);
    expect((await post(confirm, operator, confirmationBody(receipt.receiptId, 2))).status).toBe(
      200
    );
    expect((await readState(manager)).receipt?.status).toBe('confirmed');

    expect(
      (await post(reviseSource, operator, { change: { sourceType: 'inventory', damaged: 10 } }))
        .status
    ).toBe(200);
    const stale = await readState(manager);
    expect(stale.receipt?.status).toBe('stale');
    expect(stale.approval).toBeNull();
    expect(stale.supplierDraft).toBeNull();
    expect(stale.confirmation).toBeNull();
    expect(stale.tasks).toEqual([]);
    expect(stale.receiptHistory.some((r) => r.status === 'confirmed')).toBe(true);
    expect(
      getStateStore().appDb.db.prepare('SELECT * FROM supplier_confirmations').all()
    ).toHaveLength(1);

    expect((await post(investigate, operator, { orderId: 'DSP-1042' })).status).toBe(200);
    const newPlan = (await readState(manager)).receipt!;
    expect(newPlan.calculations.shortfall).toBe(50);
    expect(
      (
        await post(approve, manager, {
          receiptId: receipt.receiptId,
          expectedVersion: newPlan.version,
          idempotencyKey: 'confirm-stale-new-approval'
        })
      ).status
    ).toBe(200);
    const approved = await readState(manager);
    expect(approved.receipt?.status).toBe('awaiting_confirmation');
    expect(approved.confirmation).toBeNull();
    expect(approved.supplierDraft?.requestedQuantity).toBe(50);
    expect(
      (
        await post(
          confirm,
          operator,
          confirmationBody(receipt.receiptId, approved.receipt!.version, { confirmedQuantity: 50 })
        )
      ).status
    ).toBe(200);
    const current = await readState(manager);
    expect(current.confirmation?.confirmedQuantity).toBe(50);
    expect(current.confirmation?.receiptVersion).toBe(current.receipt?.version);
    expect(
      getStateStore().appDb.db.prepare('SELECT * FROM supplier_confirmations').all()
    ).toHaveLength(2);
  });
});
