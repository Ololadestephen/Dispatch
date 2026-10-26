import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Scout } from './scout';
import registry from './dispatchIntents.json';
import type { IntentRegistry } from './scout';

/** Dispatch's capability graph: each capability maps to one read-only source lookup. */
export const LOOKUP_TOOLS = {
  'orders.read': 'get_order',
  'inventory.read': 'get_inventory',
  'inbound.read': 'get_inbound',
  'supplier_messages.read': 'get_supplier_messages',
  'backup_listings.read': 'get_backup_listings',
  'policy.read': 'get_policy'
} as const;

export type LookupCapability = keyof typeof LOOKUP_TOOLS;

export const SUPPLIER_MESSAGE_SURFACE = 'supplier_message';

/** The per-deployment HMAC secret lives next to the app database and is never logged. */
function loadOrCreateSecret(dataDir: string): string {
  const keyPath = path.join(dataDir, 'scout_signing.key');
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return fs.readFileSync(keyPath, 'utf8').trim();
}

export function createDispatchScout(options: {
  dataDir: string;
  modelId: string;
  now?: () => number;
}): Scout {
  const scout = new Scout({
    intentRegistry: registry as IntentRegistry,
    policyPack: ['default', 'adversarial-tight'],
    modelProfiles: [{ id: options.modelId }],
    signingSecret: loadOrCreateSecret(options.dataDir),
    capabilityResolution: 'registered-only',
    untrustedSurfaces: [SUPPLIER_MESSAGE_SURFACE],
    now: options.now
  });
  for (const [capability, toolId] of Object.entries(LOOKUP_TOOLS)) {
    scout.capabilities.register({ capability, toolId, local: true });
  }
  return scout;
}
