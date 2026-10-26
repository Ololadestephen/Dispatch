import { UnresolvedQuoteError } from './errors';
import { Clock } from './clock';
import { z } from 'zod';

const IsoArrivalSchema = z.iso.datetime({ offset: true });

export interface ResolvedTextSpan {
  text: string;
  startIndex: number;
  endIndex: number;
  recordId: string;
}

export interface ResolvedQuoteSpan extends ResolvedTextSpan {
  claim: string;
}

export interface ParsedArrivalResult {
  arrivalIso: string | null;
  isAmbiguous: boolean;
  ambiguityReason?: string;
}

const MONTH_MAP: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12
};

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6
};

/**
 * Normalizes curly single/double quotes to straight quotes without changing string length.
 */
function normalizeQuotesPreservingLength(s: string): string {
  return s.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/**
 * Deterministically resolves a substring against sourceText and returns its exact [startIndex, endIndex].
 * Throws UnresolvedQuoteError if empty, not found, or duplicated ambiguously.
 */
export function resolveExactSubstringSpan(
  sourceText: string,
  candidate: string,
  recordId: string,
  label: 'quote' | 'ignoredInstruction' = 'quote'
): ResolvedTextSpan {
  const trimmed = candidate.trim();
  if (!trimmed) {
    throw new UnresolvedQuoteError(`Empty ${label} cannot be resolved against record ${recordId}`);
  }

  const normSource = normalizeQuotesPreservingLength(sourceText);
  const normCandidate = normalizeQuotesPreservingLength(trimmed);

  const firstIdx = normSource.indexOf(normCandidate);
  if (firstIdx === -1) {
    throw new UnresolvedQuoteError(
      `Model ${label} does not match source text character-for-character in record ${recordId}: "${trimmed}"`
    );
  }

  const secondIdx = normSource.indexOf(normCandidate, firstIdx + 1);
  if (secondIdx !== -1) {
    throw new UnresolvedQuoteError(
      `Ambiguous duplicate ${label} match in record ${recordId} at offsets ${firstIdx} and ${secondIdx}: "${trimmed}"`
    );
  }

  const endIndex = firstIdx + normCandidate.length;
  return {
    text: sourceText.slice(firstIdx, endIndex),
    startIndex: firstIdx,
    endIndex,
    recordId
  };
}

/**
 * Verifies all extracted quotes and ignored instructions against the source text,
 * and checks that extracted quantity and arrival text appear in the verified quotes.
 */
export function verifyExtractionAgainstSource(params: {
  sourceText: string;
  recordId: string;
  revisedArrivalText: string;
  delayedQuantity: number;
  exactQuotes: Array<{ quote: string; claim: string }>;
  ignoredInstructions: string[];
}): {
  resolvedQuotes: ResolvedQuoteSpan[];
  resolvedIgnoredInstructions: ResolvedTextSpan[];
} {
  const {
    sourceText,
    recordId,
    revisedArrivalText,
    delayedQuantity,
    exactQuotes,
    ignoredInstructions
  } = params;

  if (exactQuotes.length === 0) {
    throw new UnresolvedQuoteError(
      `Extraction for record ${recordId} must include at least one exact quote from the source text.`
    );
  }

  const resolvedQuotes: ResolvedQuoteSpan[] = exactQuotes.map((q) => {
    const span = resolveExactSubstringSpan(sourceText, q.quote, recordId, 'quote');
    return {
      ...span,
      claim: q.claim
    };
  });

  const resolvedIgnoredInstructions: ResolvedTextSpan[] = ignoredInstructions.map((inst) =>
    resolveExactSubstringSpan(sourceText, inst, recordId, 'ignoredInstruction')
  );

  // Verify that the extracted arrival phrase is grounded in the source text and resolved quotes
  const normSource = normalizeQuotesPreservingLength(sourceText);
  const normArrival = normalizeQuotesPreservingLength(revisedArrivalText.trim());
  if (!normArrival || !normSource.includes(normArrival)) {
    throw new UnresolvedQuoteError(
      `Extracted revisedArrivalText "${revisedArrivalText}" is not an exact substring of source record ${recordId}`
    );
  }

  const arrivalGroundedInQuote = resolvedQuotes.some((rq) =>
    normalizeQuotesPreservingLength(rq.text).includes(normArrival)
  );
  if (!arrivalGroundedInQuote) {
    throw new UnresolvedQuoteError(
      `Extracted revisedArrivalText "${revisedArrivalText}" is not covered by any verified quote in record ${recordId}`
    );
  }

  // Verify that the extracted quantity appears as a token in the resolved quotes
  const quantityTokenRegex = new RegExp(`\\b${delayedQuantity}\\b`);
  const quantityGroundedInQuote = resolvedQuotes.some((rq) => quantityTokenRegex.test(rq.text));
  if (!quantityGroundedInQuote) {
    throw new UnresolvedQuoteError(
      `Extracted delayedQuantity (${delayedQuantity}) is not present in any verified quote for record ${recordId}`
    );
  }

  return {
    resolvedQuotes,
    resolvedIgnoredInstructions
  };
}

/**
 * Deterministically parses a natural-language arrival phrase (e.g., "Monday 26 Oct, 9am")
 * into a canonical WAT (+01:00) ISO-8601 timestamp using the scenario clock's year.
 * Never guesses missing times; flags ambiguity if time-of-day is missing or weekday conflicts.
 */
export function parseExtractedArrivalToWatIso(
  arrivalText: string,
  clock: Clock
): ParsedArrivalResult {
  const raw = arrivalText.trim();
  if (!raw) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: 'Arrival time text is empty.'
    };
  }

  // Case 1: Explicit ISO-8601 string with timezone offset
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    if (!IsoArrivalSchema.safeParse(raw).success) {
      return {
        arrivalIso: null,
        isAmbiguous: true,
        ambiguityReason: 'Arrival timestamp has an invalid calendar date, time or timezone.'
      };
    }
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
      const wat = new Date(parsed.getTime() + 60 * 60 * 1000).toISOString();
      return {
        arrivalIso: `${wat.endsWith('.000Z') ? wat.slice(0, -5) : wat.slice(0, -1)}+01:00`,
        isAmbiguous: false
      };
    }
  }

  // Case 2: Natural language phrase e.g. "Monday 26 Oct, 9am" or "Saturday 24 Oct 07:00"
  // Extract optional weekday, day, month, optional year, and time
  const pattern =
    /^(?:(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\s*,?\s*)?(\d{1,2})\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?(?:\s*,?\s*(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i;

  const match = raw.match(pattern);
  if (!match) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Arrival phrase "${raw}" could not be deterministically parsed into a calendar date and time.`
    };
  }

  const weekdayStr = match[1]?.toLowerCase();
  const dayNum = parseInt(match[2]!, 10);
  const monthStr = match[3]!.toLowerCase();
  const explicitYear = match[4] ? parseInt(match[4], 10) : undefined;
  const hourRaw = match[5];
  const minuteRaw = match[6];
  const meridiem = match[7]?.toLowerCase();

  // Time-of-day is required for deadline comparison
  if (hourRaw === undefined) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Arrival phrase "${raw}" specifies a date without a time of day.`
    };
  }

  let hour = parseInt(hourRaw, 10);
  const minute = minuteRaw !== undefined ? parseInt(minuteRaw, 10) : 0;

  if (minute < 0 || minute > 59) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Invalid minute value in "${raw}".`
    };
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) {
      return {
        arrivalIso: null,
        isAmbiguous: true,
        ambiguityReason: `Invalid 12-hour clock value in "${raw}".`
      };
    }
    if (meridiem === 'am') {
      hour = hour === 12 ? 0 : hour;
    } else {
      hour = hour === 12 ? 12 : hour + 12;
    }
  } else {
    // Without am/pm and without ':mm' (e.g. "9"), it is ambiguous between 09:00 and 21:00
    if (minuteRaw === undefined || hour > 23) {
      return {
        arrivalIso: null,
        isAmbiguous: true,
        ambiguityReason: `Time in "${raw}" is ambiguous without AM/PM or 24-hour HH:MM format.`
      };
    }
  }

  const month = MONTH_MAP[monthStr];
  if (!month || dayNum < 1 || dayNum > 31) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Invalid calendar day/month in "${raw}".`
    };
  }

  // Scenario year derived strictly from injected scenario clock
  const scenarioYear = explicitYear ?? clock.now().getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, '0');
  const candidateIso = `${scenarioYear}-${pad(month)}-${pad(dayNum)}T${pad(hour)}:${pad(minute)}:00+01:00`;
  const candidateDate = new Date(candidateIso);

  if (isNaN(candidateDate.getTime())) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Constructed timestamp "${candidateIso}" is invalid.`
    };
  }

  // Verify calendar day did not roll over (e.g. 31 Feb)
  // In WAT (+01:00), add 1 hour to UTC to check local date parts
  const watDate = new Date(candidateDate.getTime() + 60 * 60 * 1000);
  if (
    watDate.getUTCFullYear() !== scenarioYear ||
    watDate.getUTCMonth() + 1 !== month ||
    watDate.getUTCDate() !== dayNum
  ) {
    return {
      arrivalIso: null,
      isAmbiguous: true,
      ambiguityReason: `Date "${raw}" does not exist in calendar year ${scenarioYear}.`
    };
  }

  // Verify weekday matches calendar date if weekday was stated
  if (weekdayStr !== undefined) {
    const expectedWeekday = WEEKDAY_MAP[weekdayStr];
    const actualWeekday = watDate.getUTCDay();
    if (expectedWeekday !== undefined && expectedWeekday !== actualWeekday) {
      return {
        arrivalIso: null,
        isAmbiguous: true,
        ambiguityReason: `Stated weekday "${match[1]}" conflicts with calendar date ${dayNum} ${match[3]} ${scenarioYear}.`
      };
    }
  }

  return {
    arrivalIso: candidateIso,
    isAmbiguous: false
  };
}
