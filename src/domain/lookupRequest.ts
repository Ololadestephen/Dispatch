import { z } from 'zod';

/** The single optional follow-up for this scenario. No model-provided SQL, URL or write tool. */
export const ModelLookupRequestSchema = z.strictObject({
  tool: z.literal('get_backup_listings'),
  args: z.strictObject({ sku: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/) }),
  reason: z.string().min(1).max(240)
});
export const ModelLookupRequestsSchema = z.array(ModelLookupRequestSchema).max(1);
export type ModelLookupRequest = z.infer<typeof ModelLookupRequestSchema>;
