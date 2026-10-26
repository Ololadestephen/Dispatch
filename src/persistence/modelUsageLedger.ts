import crypto from 'node:crypto';
import { z } from 'zod';
import { AppDatabase } from './appDb';
import { DomainError } from '../domain/errors';
import {
  DEFAULT_EXECUTION_LIMITS,
  ExecutionLimitsSchema,
  MODEL_CALL_TOKEN_ALLOWANCE,
  type ExecutionLimits
} from '../domain/executionLimits';

const TotalsSchema = z.object({
  calls: z.number().int().nonnegative(),
  charged_tokens: z.number().int().nonnegative(),
  pending_calls: z.number().int().nonnegative(),
  failed_calls: z.number().int().nonnegative()
});

export interface ModelBudgetSummary {
  trackingStartedAtIso: string;
  calls: number;
  chargedTokens: number;
  pendingCalls: number;
  failedCalls: number;
  maxCalls: number;
  maxTokens: number;
  remainingCalls: number;
  remainingTokens: number;
  canCall: boolean;
}

/** Atomic reservations across connections; no prompt, response or credential is stored here. */
export class ModelUsageLedger {
  private readonly limits: ExecutionLimits;
  constructor(
    private readonly database: AppDatabase,
    limits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS
  ) {
    this.limits = ExecutionLimitsSchema.parse(limits);
  }

  summary(): ModelBudgetSummary {
    const totals = TotalsSchema.parse(
      this.database.db
        .prepare(
          `
      SELECT COUNT(*) AS calls,
        COALESCE(SUM(COALESCE(o.reported_tokens, r.reserved_tokens)), 0) AS charged_tokens,
        COALESCE(SUM(CASE WHEN o.attempt_id IS NULL THEN 1 ELSE 0 END), 0) AS pending_calls,
        COALESCE(SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_calls
      FROM model_call_reservations r LEFT JOIN model_call_outcomes o USING (attempt_id)
    `
        )
        .get()
    );
    const metadata = z
      .object({ tracking_started_at_iso: z.string() })
      .parse(
        this.database.db
          .prepare('SELECT tracking_started_at_iso FROM model_usage_metadata WHERE singleton = 1')
          .get()
      );
    return {
      trackingStartedAtIso: metadata.tracking_started_at_iso,
      calls: totals.calls,
      chargedTokens: totals.charged_tokens,
      pendingCalls: totals.pending_calls,
      failedCalls: totals.failed_calls,
      maxCalls: this.limits.maxCalls,
      maxTokens: this.limits.maxTokens,
      remainingCalls: Math.max(0, this.limits.maxCalls - totals.calls),
      remainingTokens: Math.max(0, this.limits.maxTokens - totals.charged_tokens),
      canCall:
        totals.calls < this.limits.maxCalls &&
        totals.charged_tokens + MODEL_CALL_TOKEN_ALLOWANCE <= this.limits.maxTokens
    };
  }

  /** Reserves before a live call; failure means the provider must not be contacted. */
  reserve(input: { runId: string; orderId: string; actorUserId: string; model: string }): string {
    return this.database.runInTransaction(() => {
      const total = this.summary();
      if (
        total.calls >= this.limits.maxCalls ||
        total.chargedTokens + MODEL_CALL_TOKEN_ALLOWANCE > this.limits.maxTokens
      ) {
        throw new DomainError(
          'Model budget exhausted. Existing usage has been preserved.',
          'MODEL_BUDGET_EXCEEDED'
        );
      }
      const attemptId = crypto.randomUUID();
      this.database.db
        .prepare(
          `INSERT INTO model_call_reservations
        (attempt_id, run_id, order_id, actor_user_id, model, reserved_tokens, started_at_iso)
        VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          attemptId,
          input.runId,
          input.orderId,
          input.actorUserId,
          input.model,
          MODEL_CALL_TOKEN_ALLOWANCE,
          new Date().toISOString()
        );
      return attemptId;
    });
  }

  /** Only a validated provider token count releases unused allowance; unknown usage stays charged. */
  finish(
    attemptId: string,
    outcome: { status: 'succeeded' | 'failed'; reportedTokens?: number; errorCode?: string }
  ): void {
    const tokens = z
      .number()
      .int()
      .nonnegative()
      .max(1_000_000_000)
      .optional()
      .parse(outcome.reportedTokens);
    this.database.db
      .prepare(
        `INSERT INTO model_call_outcomes
      (attempt_id, status, reported_tokens, error_code, finished_at_iso) VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        attemptId,
        outcome.status,
        tokens ?? null,
        outcome.errorCode ?? null,
        new Date().toISOString()
      );
  }
}
