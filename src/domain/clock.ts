/**
 * Frozen scenario clock definition and contract.
 *
 * Demo scenario requirement:
 * All domain deadline, stock eligibility, and staleness checks MUST use
 * the scenario clock, never wall clock (new Date()).
 */

export interface Clock {
  now(): Date;
  nowIso(): string;
}

/**
 * Frozen baseline for the Dispatch Lagos wedding-chair scenario:
 * Thursday, 22 October 2026, 15:00:00 WAT (UTC+1).
 */
export const FROZEN_SCENARIO_TIME_ISO = '2026-10-22T15:00:00+01:00';

export class FrozenClock implements Clock {
  private readonly fixedDate: Date;

  constructor(isoString: string = FROZEN_SCENARIO_TIME_ISO) {
    this.fixedDate = new Date(isoString);
    if (isNaN(this.fixedDate.getTime())) {
      throw new Error(`Invalid frozen clock ISO timestamp: ${isoString}`);
    }
  }

  now(): Date {
    return new Date(this.fixedDate.getTime());
  }

  nowIso(): string {
    return this.fixedDate.toISOString();
  }
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}
