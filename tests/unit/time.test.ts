import { describe, expect, it } from 'vitest';
import { formatWat, weekdayWat } from '../../src/domain/time';

describe('WAT time formatting', () => {
  it('formats an ISO timestamp in Lagos time with the WAT suffix', () => {
    expect(formatWat('2026-10-24T09:00:00+01:00')).toBe('Sat 24 Oct, 09:00 WAT');
  });

  it('uses explicit words for unverified and unparseable values', () => {
    expect(formatWat('UNVERIFIED')).toBe('Not verified');
    expect(formatWat('not-a-date')).toBe('Unclear');
  });

  it('names the weekday of a WAT deadline', () => {
    expect(weekdayWat('2026-10-24T09:00:00+01:00')).toBe('Saturday');
  });

  it('degrades to "that day" on an unparseable deadline instead of throwing', () => {
    expect(() => weekdayWat('not-a-date')).not.toThrow();
    expect(weekdayWat('not-a-date')).toBe('that day');
  });
});
