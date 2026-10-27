import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors';
import { parseJsonOrThrow } from '../../src/domain/json';

describe('stored JSON parsing', () => {
  it('returns the parsed value for valid JSON', () => {
    expect(parseJsonOrThrow('{"a":1}', 'Stored record', 'STORED_RECORD_CORRUPT')).toEqual({
      a: 1
    });
  });

  it('wraps malformed JSON in a typed error that names the record and the code', () => {
    let caught: unknown;
    try {
      parseJsonOrThrow('{"a":', 'Supplier message line 2', 'STORED_RECORD_CORRUPT');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const error = caught as DomainError;
    expect(error.code).toBe('STORED_RECORD_CORRUPT');
    expect(error.message).toContain('Supplier message line 2');
    expect(error.message).toContain('is not valid JSON');
  });

  it('keeps the parser message so the corruption is diagnosable', () => {
    expect(() => parseJsonOrThrow('[1,', 'Backup listing store', 'STORED_RECORD_CORRUPT')).toThrow(
      /Unexpected end of JSON input|Unterminated/
    );
  });
});
