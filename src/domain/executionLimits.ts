import { z } from 'zod';

export const MAX_MODEL_PROMPT_BYTES = 12_288;
export const MAX_SUPPLIER_TEXT_BYTES = 8_192;
export const MAX_MODEL_OUTPUT_TOKENS = 1_024;
/** Conservative per-call allowance; unknown/unfinished calls retain the full charge. */
export const MODEL_CALL_TOKEN_ALLOWANCE = 16_384;

export const ExecutionLimitsSchema = z.strictObject({
  maxCalls: z.number().int().nonnegative().max(10_000).default(100),
  maxTokens: z.number().int().nonnegative().max(1_000_000_000).default(1_000_000),
  workflowTimeoutMs: z.number().int().positive().max(300_000).default(120_000)
});

export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;
export const DEFAULT_EXECUTION_LIMITS = ExecutionLimitsSchema.parse({});
