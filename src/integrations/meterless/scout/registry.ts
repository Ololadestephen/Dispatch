import fs from 'node:fs';
import { z } from 'zod';
import type { IntentRegistry } from './types';
import { parseJsonOrThrow } from '../../../domain/json';

const ParameterPropertySchema = z
  .object({
    type: z.enum(['integer', 'number', 'string', 'boolean', 'array', 'object']).optional(),
    enum: z.array(z.string()).optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional()
  })
  .passthrough();

const IntentSchema = z.object({
  id: z.string().regex(/^(GENERAL|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)$/),
  category: z.string().min(1),
  description: z.string().min(1),
  parameters: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), ParameterPropertySchema),
    required: z.array(z.string()).optional()
  }),
  capabilities: z.array(z.string()),
  riskClass: z.enum(['low', 'medium', 'high']),
  surfaces: z.array(z.string()).min(1),
  roles: z.array(z.string()).min(1),
  // The spec makes examples mandatory: an intent without examples cannot be classified.
  examples: z.array(z.string().min(1)).min(1),
  version: z.number().int().positive()
});

const RegistrySchema = z.object({
  version: z.number().int().positive(),
  intents: z.array(IntentSchema).min(1)
});

/** Loads a registry from a JSON file path or an object, validating the spec's record shape. */
export function loadRegistry(source: string | IntentRegistry): IntentRegistry {
  const raw: unknown =
    typeof source === 'string'
      ? parseJsonOrThrow(fs.readFileSync(source, 'utf8'), 'Scout registry', 'INVALID_REGISTRY')
      : source;
  const registry = RegistrySchema.parse(raw) as IntentRegistry;
  if (!registry.intents.some((i) => i.id === 'GENERAL')) {
    throw new Error('Scout registry must contain the GENERAL fallback intent.');
  }
  return registry;
}
