import { DomainError } from './errors';

/** Parses stored or source JSON; malformed text becomes an explicit, typed error. */
export function parseJsonOrThrow(text: string, what: string, code: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new DomainError(`${what} is not valid JSON: ${(err as Error).message}`, code);
  }
}
