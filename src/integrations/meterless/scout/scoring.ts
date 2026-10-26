import type { Band, Intent, IntentCandidate, IntentRegistry } from './types';

/**
 * Sense stage, Stage 1 only (docs/scoring.md): a deterministic weighted trigger scan over the full
 * registry. Stage 2 (semantic/contextual rescoring with a local model) is not implemented, so per
 * the spec Stage 1's result stands.
 *
 * Implementer's choices (the spec leaves them open):
 * - Triggers are word unigrams and bigrams taken from each intent's id, examples and description,
 *   weighted id > example bigram > example word > description word.
 * - lexical(intent) = matched trigger weight / total weight of the prompt's features (0..1).
 * - Stage-1 confidence = winner's lexical score scaled by its share of the top-two matched weight,
 *   so a weak or contested match never lands in the High band.
 */

const STOPWORDS = new Set(
  'a an the and or but to of for in on at by with from into about me my our your you i we it is are be this that these those can could would should please what which who how do does did any some all them they their there here up out as so if then than just also'.split(
    ' '
  )
);

const WEIGHTS = { id: 2.0, exampleBigram: 1.5, exampleWord: 1.0, descriptionWord: 0.5 };

export const BANDS = { high: 0.8, medium: 0.55, low: 0.4 } as const;

function stem(word: string): string {
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function features(text: string): Set<string> {
  const words = tokenize(text);
  const out = new Set(words);
  for (let i = 0; i + 1 < words.length; i++) out.add(`${words[i]} ${words[i + 1]}`);
  return out;
}

type TriggerTable = Map<string, Map<string, number>>; // feature -> intentId -> weight

function addTrigger(table: TriggerTable, feature: string, intentId: string, weight: number) {
  const row = table.get(feature) ?? new Map<string, number>();
  row.set(intentId, Math.max(row.get(intentId) ?? 0, weight));
  table.set(feature, row);
}

export function buildTriggerTable(registry: IntentRegistry): TriggerTable {
  const table: TriggerTable = new Map();
  for (const intent of registry.intents) {
    if (intent.id === 'GENERAL') continue;
    for (const part of tokenize(intent.id.replace(/[.-]/g, ' '))) {
      addTrigger(table, part, intent.id, WEIGHTS.id);
    }
    for (const example of intent.examples) {
      for (const f of features(example)) {
        addTrigger(
          table,
          f,
          intent.id,
          f.includes(' ') ? WEIGHTS.exampleBigram : WEIGHTS.exampleWord
        );
      }
    }
    for (const word of tokenize(intent.description)) {
      addTrigger(table, word, intent.id, WEIGHTS.descriptionWord);
    }
  }
  return table;
}

/** Raw lexical scores for every intent that matched at least one trigger. */
function lexicalScores(prompt: string, table: TriggerTable): Map<string, number> {
  const promptFeatures = features(prompt);
  const matched = new Map<string, number>();
  let promptWeight = 0;
  for (const f of promptFeatures) {
    const row = table.get(f);
    promptWeight += f.includes(' ') ? WEIGHTS.exampleBigram : WEIGHTS.exampleWord;
    if (!row) continue;
    for (const [intentId, w] of row) matched.set(intentId, (matched.get(intentId) ?? 0) + w);
  }
  const scores = new Map<string, number>();
  if (promptWeight === 0) return scores;
  for (const [intentId, w] of matched) scores.set(intentId, Math.min(1, w / promptWeight));
  return scores;
}

export function bandFor(score: number): Band {
  if (score >= BANDS.high) return 'high';
  if (score >= BANDS.medium) return 'medium';
  if (score >= BANDS.low) return 'low';
  return 'reject';
}

/** Top-k candidates with Stage-1 confidence; GENERAL is never a scored candidate. */
export function scorePrompt(prompt: string, table: TriggerTable, k = 5): IntentCandidate[] {
  const lexical = [...lexicalScores(prompt, table).entries()].sort((a, b) => b[1] - a[1]);
  if (lexical.length === 0) return [];
  const top1 = lexical[0]![1];
  const top2 = lexical[1]?.[1] ?? 0;
  return lexical.slice(0, k).map(([intent, raw], i) => {
    const contested = i === 0 ? top1 + top2 : top1 + raw;
    const share = contested > 0 ? raw / contested : 0;
    // 0.40 * lexical is the canonical Stage-1 term; the share rescales it to a confidence.
    const score = Math.min(1, raw * share * 2.4);
    return { intent, score: Math.round(score * 1000) / 1000 };
  });
}

/** Splits a prompt into clause spans for multi-intent detection (docs/scoring.md). */
export function clauseSpans(prompt: string): string[] {
  return prompt
    .split(/\s*(?:,\s*then\s+|\s+and\s+then\s+|\s+and\s+(?=[a-z]+\b)|;\s*|,\s*and\s+)/i)
    .map((s) => s.trim())
    .filter((s) => tokenize(s).length >= 2);
}

/** Startup self-test: a full-registry scan must finish in under 16 ms (AGENTS.md §4.1). */
export function selfTestLatency(table: TriggerTable, registry: IntentRegistry): number {
  const probes = registry.intents.flatMap((i: Intent) => i.examples.slice(0, 1));
  const start = performance.now();
  for (const p of probes) scorePrompt(p, table);
  const perScan = (performance.now() - start) / Math.max(1, probes.length);
  if (perScan >= 16) {
    throw new Error(
      `Scout Stage-1 self-test failed: ${perScan.toFixed(1)} ms per scan (budget 16 ms).`
    );
  }
  return perScan;
}
