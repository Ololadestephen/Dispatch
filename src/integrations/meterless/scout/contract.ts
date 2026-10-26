import crypto from 'node:crypto';
import type { ExecutionContract } from './types';

/** Default TTL from docs/execution-contract.md. Never extended; long work re-issues. */
export const CONTRACT_TTL_MS = 5 * 60 * 1000;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastUlid = { ms: 0, rand: '' };

/** Monotonic ULID (time-ordered id, as the spec requires for contractId). */
export function ulid(nowMs = Date.now()): string {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let rand: string;
  if (nowMs === lastUlid.ms) {
    // Increment the previous random part so ids stay ordered within one millisecond.
    const chars = lastUlid.rand.split('');
    for (let i = chars.length - 1; i >= 0; i--) {
      const v = CROCKFORD.indexOf(chars[i]!);
      if (v < 31) {
        chars[i] = CROCKFORD[v + 1]!;
        break;
      }
      chars[i] = '0';
    }
    rand = chars.join('');
  } else {
    rand = Array.from(crypto.randomBytes(16), (b) => CROCKFORD[b % 32]).join('');
  }
  lastUlid = { ms: nowMs, rand };
  return time + rand;
}

/** Canonical JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signContract(
  unsigned: Omit<ExecutionContract, 'signature' | 'signedBy'>,
  secret: string
): ExecutionContract {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonicalJson(unsigned))
    .digest('hex');
  return { ...unsigned, signature, signedBy: 'scout' };
}

export class ContractRefusedError extends Error {
  constructor(
    message: string,
    public readonly reason: 'unsigned' | 'tampered' | 'expired' | 'scope-mismatch'
  ) {
    super(message);
  }
}

/**
 * Executor-side verification: signature, expiry and scope. Every downstream call must pass this;
 * a refusal is the spec's `contract.refused` event.
 */
export function verifyContract(
  contract: ExecutionContract,
  secret: string,
  check: { capability: string; nowMs: number }
): void {
  if (!contract.signature || contract.signedBy !== 'scout') {
    throw new ContractRefusedError('Contract is unsigned.', 'unsigned');
  }
  const { signature, signedBy: _signedBy, ...unsigned } = contract;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(canonicalJson(unsigned))
    .digest('hex');
  const a = Buffer.from(signature, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new ContractRefusedError('Contract signature does not match.', 'tampered');
  }
  if (check.nowMs > Date.parse(contract.expiresAt)) {
    throw new ContractRefusedError(`Contract ${contract.contractId} expired.`, 'expired');
  }
  if (!contract.scope.capabilities.includes(check.capability)) {
    throw new ContractRefusedError(
      `Capability ${check.capability} is outside contract ${contract.contractId}.`,
      'scope-mismatch'
    );
  }
}
