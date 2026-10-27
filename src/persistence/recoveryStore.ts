import crypto from 'node:crypto';
import { DecisionReceipt, validateDecisionReceipt } from '../domain/receipt';
import type { UserRole, UserSession } from '../domain/policy';
import type {
  ApprovalRecord,
  InternalRecoveryTask,
  SupplierConfirmationRecord,
  SupplierRequestDraft,
  AuditEventRecord
} from '../domain/recoveryRecords';
import type { BackupReservationRecord } from '../domain/reservation';
import { parseJsonOrThrow } from '../domain/json';
import { AppDatabase } from './appDb';

const parseStored = (text: string, what: string) =>
  parseJsonOrThrow(text, what, 'STORED_RECORD_CORRUPT');

/** Concrete recovery persistence. Callers group writes with transaction(). */
export class RecoveryStore {
  constructor(readonly database = new AppDatabase()) {}

  transaction<T>(work: () => T): T {
    return this.database.runInTransaction(work);
  }

  insertReceiptVersion(receipt: DecisionReceipt, nowIso: string): void {
    this.database.db
      .prepare(
        `
      INSERT INTO receipt_versions (
        receipt_id, version, order_id, status, execution_mode, payload_json, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `
      )
      .run(
        receipt.receiptId,
        receipt.version,
        receipt.orderId,
        receipt.status,
        receipt.executionMode ?? 'live',
        JSON.stringify(receipt),
        nowIso
      );
  }

  getReceipt(receiptId: string): DecisionReceipt | undefined {
    const stmt = this.database.db.prepare(`
      SELECT payload_json
      FROM receipt_versions
      WHERE receipt_id = ?
      ORDER BY version DESC
      LIMIT 1
    `);
    const row = stmt.get(receiptId) as { payload_json: string } | undefined;
    if (!row) {
      return undefined;
    }
    return validateDecisionReceipt(parseStored(row.payload_json, `Receipt ${receiptId}`));
  }

  getReceiptHistory(receiptId: string): DecisionReceipt[] {
    const stmt = this.database.db.prepare(`
      SELECT payload_json
      FROM receipt_versions
      WHERE receipt_id = ?
      ORDER BY version ASC
    `);
    const rows = stmt.all(receiptId) as Array<{ payload_json: string }>;
    return rows.map((r) =>
      validateDecisionReceipt(parseStored(r.payload_json, `Receipt ${receiptId}`))
    );
  }

  /** Latest version of every receipt, used to find competing plans for one backup lot. */
  listLatestReceipts(): DecisionReceipt[] {
    const rows = this.database.db
      .prepare(
        `
      SELECT rv.payload_json
      FROM receipt_versions rv
      JOIN (
        SELECT receipt_id, MAX(version) AS version
        FROM receipt_versions
        GROUP BY receipt_id
      ) latest ON latest.receipt_id = rv.receipt_id AND latest.version = rv.version
      ORDER BY rv.order_id ASC
    `
      )
      .all() as Array<{ payload_json: string }>;
    return rows.map((r) => validateDecisionReceipt(parseStored(r.payload_json, 'Receipt')));
  }

  listActiveReservations(backupListingId?: string): BackupReservationRecord[] {
    return this.listReservations(backupListingId, true);
  }

  /** Full reservation history for the World Model mirror, including releases. */
  listReservations(backupListingId?: string, activeOnly = false): BackupReservationRecord[] {
    const sql = `
      SELECT reservation_id, backup_listing_id, backup_revision_id, sku, order_id, receipt_id,
             receipt_version, quantity, status, idempotency_key, created_at_iso,
             released_at_iso, release_reason
      FROM backup_reservations
      WHERE ${activeOnly ? "status = 'active'" : '1 = 1'}${backupListingId ? ' AND backup_listing_id = ?' : ''}
      ORDER BY created_at_iso ASC, reservation_id ASC
    `;
    const rows = (
      backupListingId
        ? this.database.db.prepare(sql).all(backupListingId)
        : this.database.db.prepare(sql).all()
    ) as Array<{
      reservation_id: string;
      backup_listing_id: string;
      backup_revision_id: string;
      sku: string;
      order_id: string;
      receipt_id: string;
      receipt_version: number;
      quantity: number;
      status: 'active' | 'released';
      idempotency_key: string;
      created_at_iso: string;
      released_at_iso: string | null;
      release_reason: string | null;
    }>;
    return rows.map((row) => this.mapReservation(row));
  }

  insertReservation(record: BackupReservationRecord): void {
    this.database.db
      .prepare(
        `
      INSERT INTO backup_reservations (
        reservation_id, backup_listing_id, backup_revision_id, sku, order_id, receipt_id,
        receipt_version, quantity, status, idempotency_key, created_at_iso,
        released_at_iso, release_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `
      )
      .run(
        record.reservationId,
        record.backupListingId,
        record.backupRevisionId,
        record.sku,
        record.orderId,
        record.receiptId,
        record.receiptVersion,
        record.quantity,
        record.status,
        record.idempotencyKey,
        record.createdAtIso,
        record.releasedAtIso ?? null,
        record.releaseReason ?? null
      );
  }

  /** Marks every active reservation for a receipt released and returns what changed. */
  releaseActiveReservations(
    receiptId: string,
    reason: string,
    releasedAtIso: string
  ): BackupReservationRecord[] {
    const active = this.listActiveReservations().filter((r) => r.receiptId === receiptId);
    if (active.length === 0) return [];
    this.database.db
      .prepare(
        `UPDATE backup_reservations
         SET status = 'released', released_at_iso = ?, release_reason = ?
         WHERE receipt_id = ? AND status = 'active';`
      )
      .run(releasedAtIso, reason, receiptId);
    return active.map((r) => ({
      ...r,
      status: 'released',
      releasedAtIso,
      releaseReason: reason
    }));
  }

  private mapReservation(row: {
    reservation_id: string;
    backup_listing_id: string;
    backup_revision_id: string;
    sku: string;
    order_id: string;
    receipt_id: string;
    receipt_version: number;
    quantity: number;
    status: 'active' | 'released';
    idempotency_key: string;
    created_at_iso: string;
    released_at_iso: string | null;
    release_reason: string | null;
  }): BackupReservationRecord {
    const { released_at_iso, release_reason, ...rest } = row;
    return {
      reservationId: rest.reservation_id,
      backupListingId: rest.backup_listing_id,
      backupRevisionId: rest.backup_revision_id,
      sku: rest.sku,
      orderId: rest.order_id,
      receiptId: rest.receipt_id,
      receiptVersion: rest.receipt_version,
      quantity: rest.quantity,
      status: rest.status,
      idempotencyKey: rest.idempotency_key,
      createdAtIso: rest.created_at_iso,
      ...(released_at_iso ? { releasedAtIso: released_at_iso } : {}),
      ...(release_reason ? { releaseReason: release_reason } : {})
    };
  }

  getApproval(receiptId: string): ApprovalRecord | undefined {
    const stmt = this.database.db.prepare(`
      SELECT approval_id, receipt_id, receipt_version, approved_by_user_id, approved_by_name, approved_by_role, idempotency_key, approved_at_iso
      FROM approvals
      WHERE receipt_id = ?
      ORDER BY receipt_version DESC
      LIMIT 1
    `);
    const row = stmt.get(receiptId) as
      | {
          approval_id: string;
          receipt_id: string;
          receipt_version: number;
          approved_by_user_id: string;
          approved_by_name: string;
          approved_by_role: UserRole;
          idempotency_key: string;
          approved_at_iso: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      approvalId: row.approval_id,
      receiptId: row.receipt_id,
      receiptVersion: row.receipt_version,
      approvedByUserId: row.approved_by_user_id,
      approvedByName: row.approved_by_name,
      approvedByRole: row.approved_by_role,
      idempotencyKey: row.idempotency_key,
      approvedAtIso: row.approved_at_iso
    };
  }

  /** Tasks for the latest approved version; prior versions remain stored as history. */
  getTasks(receiptId: string): InternalRecoveryTask[] {
    const stmt = this.database.db.prepare(`
      SELECT task_id, order_id, receipt_id, receipt_version, title, assigned_role, status, created_at_iso
      FROM recovery_tasks
      WHERE receipt_id = ?
        AND receipt_version = (
          SELECT MAX(receipt_version) FROM recovery_tasks WHERE receipt_id = ?
        )
      ORDER BY task_id ASC
    `);
    const rows = stmt.all(receiptId, receiptId) as Array<{
      task_id: string;
      order_id: string;
      receipt_id: string;
      receipt_version: number;
      title: string;
      assigned_role: 'warehouse' | 'procurement' | 'dispatch';
      status: 'pending' | 'completed';
      created_at_iso: string;
    }>;
    return rows.map((row) => ({
      taskId: row.task_id,
      orderId: row.order_id,
      receiptId: row.receipt_id,
      receiptVersion: row.receipt_version,
      title: row.title,
      assignedRole: row.assigned_role,
      status: row.status,
      createdAtIso: row.created_at_iso
    }));
  }

  getSupplierDraft(receiptId: string): SupplierRequestDraft | undefined {
    const stmt = this.database.db.prepare(`
      SELECT draft_id, order_id, receipt_id, receipt_version, supplier_name, sku, requested_quantity, offered_cost_kobo, required_delivery_by_iso, status, body_text, created_at_iso
      FROM supplier_request_drafts
      WHERE receipt_id = ?
      ORDER BY receipt_version DESC
      LIMIT 1
    `);
    const row = stmt.get(receiptId) as
      | {
          draft_id: string;
          order_id: string;
          receipt_id: string;
          receipt_version: number;
          supplier_name: string;
          sku: string;
          requested_quantity: number;
          offered_cost_kobo: number;
          required_delivery_by_iso: string;
          status: 'draft_prepared' | 'ready_for_operator_review';
          body_text: string;
          created_at_iso: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      draftId: row.draft_id,
      orderId: row.order_id,
      receiptId: row.receipt_id,
      receiptVersion: row.receipt_version,
      supplierName: row.supplier_name,
      sku: row.sku,
      requestedQuantity: row.requested_quantity,
      offeredCostKobo: row.offered_cost_kobo,
      requiredDeliveryByIso: row.required_delivery_by_iso,
      status: row.status,
      isSent: false,
      bodyText: row.body_text,
      createdAtIso: row.created_at_iso
    };
  }

  getConfirmation(receiptId: string): SupplierConfirmationRecord | undefined {
    const stmt = this.database.db.prepare(`
      SELECT confirmation_id, receipt_id, receipt_version, supplier_name, sku, confirmed_quantity, confirmed_arrival_iso, confirmation_reference, evidence_excerpt, is_simulated, recorded_by_user_id, recorded_by_name, recorded_by_role, recorded_at_iso
      FROM supplier_confirmations
      WHERE receipt_id = ?
      ORDER BY receipt_version DESC
      LIMIT 1
    `);
    const row = stmt.get(receiptId) as
      | {
          confirmation_id: string;
          receipt_id: string;
          receipt_version: number;
          supplier_name: string;
          sku: string;
          confirmed_quantity: number;
          confirmed_arrival_iso: string;
          confirmation_reference: string;
          evidence_excerpt: string;
          is_simulated: number;
          recorded_by_user_id: string;
          recorded_by_name: string;
          recorded_by_role: UserRole;
          recorded_at_iso: string;
        }
      | undefined;

    if (!row) return undefined;
    return {
      confirmationId: row.confirmation_id,
      receiptId: row.receipt_id,
      receiptVersion: row.receipt_version,
      supplierName: row.supplier_name,
      sku: row.sku,
      confirmedQuantity: row.confirmed_quantity,
      confirmedArrivalIso: row.confirmed_arrival_iso,
      confirmationReference: row.confirmation_reference,
      evidenceExcerpt: row.evidence_excerpt,
      simulated: true,
      recordedByUserId: row.recorded_by_user_id,
      recordedByName: row.recorded_by_name,
      recordedByRole: row.recorded_by_role,
      recordedAtIso: row.recorded_at_iso
    };
  }

  getAuditEvents(receiptId?: string): AuditEventRecord[] {
    const stmt = receiptId
      ? this.database.db.prepare(`
          SELECT event_id, order_id, receipt_id, receipt_version, event_type, actor_user_id, actor_name, actor_role, scenario_time_iso, wall_clock_iso, summary, details_json
          FROM audit_events
          WHERE receipt_id = ?
          ORDER BY rowid ASC
        `)
      : this.database.db.prepare(`
          SELECT event_id, order_id, receipt_id, receipt_version, event_type, actor_user_id, actor_name, actor_role, scenario_time_iso, wall_clock_iso, summary, details_json
          FROM audit_events
          ORDER BY rowid ASC
        `);

    const rows = (receiptId ? stmt.all(receiptId) : stmt.all()) as Array<{
      event_id: string;
      order_id: string;
      receipt_id: string | null;
      receipt_version: number | null;
      event_type: string;
      actor_user_id: string;
      actor_name: string;
      actor_role: string;
      scenario_time_iso: string;
      wall_clock_iso: string;
      summary: string;
      details_json: string;
    }>;

    return rows.map((r) => ({
      eventId: r.event_id,
      orderId: r.order_id,
      receiptId: r.receipt_id,
      receiptVersion: r.receipt_version,
      eventType: r.event_type,
      actorUserId: r.actor_user_id,
      actorName: r.actor_name,
      actorRole: r.actor_role,
      scenarioTimeIso: r.scenario_time_iso,
      wallClockIso: r.wall_clock_iso,
      summary: r.summary,
      details: parseStored(r.details_json, `Audit event ${r.event_id}`) as Record<string, unknown>
    }));
  }

  insertApproval(approval: ApprovalRecord): void {
    this.database.db
      .prepare(
        `
      INSERT INTO approvals (
        approval_id, receipt_id, receipt_version, approved_by_user_id, approved_by_name,
        approved_by_role, idempotency_key, approved_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `
      )
      .run(
        approval.approvalId,
        approval.receiptId,
        approval.receiptVersion,
        approval.approvedByUserId,
        approval.approvedByName,
        approval.approvedByRole,
        approval.idempotencyKey,
        approval.approvedAtIso
      );
  }

  insertTasks(tasks: InternalRecoveryTask[]): void {
    const insert = this.database.db.prepare(`
      INSERT INTO recovery_tasks (
        task_id, order_id, receipt_id, receipt_version, title, assigned_role, status, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const task of tasks) {
      insert.run(
        task.taskId,
        task.orderId,
        task.receiptId,
        task.receiptVersion,
        task.title,
        task.assignedRole,
        task.status,
        task.createdAtIso
      );
    }
  }

  insertSupplierDraft(draft: SupplierRequestDraft): void {
    this.database.db
      .prepare(
        `
      INSERT INTO supplier_request_drafts (
        draft_id, order_id, receipt_id, receipt_version, supplier_name, sku, requested_quantity,
        offered_cost_kobo, required_delivery_by_iso, status, is_sent, body_text, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?);
    `
      )
      .run(
        draft.draftId,
        draft.orderId,
        draft.receiptId,
        draft.receiptVersion,
        draft.supplierName,
        draft.sku,
        draft.requestedQuantity,
        draft.offeredCostKobo,
        draft.requiredDeliveryByIso,
        draft.status,
        draft.bodyText,
        draft.createdAtIso
      );
  }

  insertConfirmation(confirmation: SupplierConfirmationRecord): void {
    this.database.db
      .prepare(
        `
      INSERT INTO supplier_confirmations (
        confirmation_id, receipt_id, receipt_version, supplier_name, sku,
        confirmed_quantity, confirmed_arrival_iso, confirmation_reference,
        evidence_excerpt, is_simulated, recorded_by_user_id, recorded_by_name,
        recorded_by_role, recorded_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?);
    `
      )
      .run(
        confirmation.confirmationId,
        confirmation.receiptId,
        confirmation.receiptVersion,
        confirmation.supplierName,
        confirmation.sku,
        confirmation.confirmedQuantity,
        confirmation.confirmedArrivalIso,
        confirmation.confirmationReference,
        confirmation.evidenceExcerpt,
        confirmation.recordedByUserId,
        confirmation.recordedByName,
        confirmation.recordedByRole,
        confirmation.recordedAtIso
      );
  }

  findIdempotentResponse<T>(scopedKey: string): T | undefined {
    const row = this.database.db
      .prepare('SELECT response_json FROM idempotency_records WHERE scoped_key = ?')
      .get(scopedKey) as { response_json: string } | undefined;
    return row
      ? (parseStored(row.response_json, `Idempotency record ${scopedKey}`) as T)
      : undefined;
  }

  storeIdempotentResponse(
    scopedKey: string,
    receiptId: string,
    receiptVersion: number,
    actorUserId: string,
    nowIso: string,
    response: unknown
  ): void {
    this.database.db
      .prepare(
        `INSERT INTO idempotency_records (
          scoped_key, receipt_id, receipt_version, actor_user_id, response_json, created_at_iso
        ) VALUES (?, ?, ?, ?, ?, ?);`
      )
      .run(scopedKey, receiptId, receiptVersion, actorUserId, JSON.stringify(response), nowIso);
  }

  insertAuditEvent(params: {
    orderId: string;
    receiptId: string | null;
    receiptVersion: number | null;
    eventType: string;
    actor: UserSession;
    scenarioTimeIso: string;
    summary: string;
    details: Record<string, unknown>;
  }): void {
    const stmt = this.database.db.prepare(`
      INSERT INTO audit_events (
        event_id, order_id, receipt_id, receipt_version, event_type,
        actor_user_id, actor_name, actor_role,
        scenario_time_iso, wall_clock_iso, summary, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    stmt.run(
      `AUD-${crypto.randomUUID().slice(0, 12)}`,
      params.orderId,
      params.receiptId,
      params.receiptVersion,
      params.eventType,
      params.actor.userId,
      params.actor.name,
      params.actor.role,
      params.scenarioTimeIso,
      new Date().toISOString(),
      params.summary,
      JSON.stringify(params.details)
    );
  }
}
