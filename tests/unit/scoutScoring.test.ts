import { describe, expect, it } from 'vitest';
import {
  BANDS,
  bandFor,
  buildTriggerTable,
  clauseSpans,
  scorePrompt,
  tokenize
} from '../../src/integrations/meterless/scout/scoring';
import type { Intent, IntentRegistry } from '../../src/integrations/meterless/scout/types';

const intent = (overrides: Partial<Intent> = {}): Intent => ({
  id: 'order.investigate',
  category: 'orders',
  description: 'Investigate an order and find recovery options',
  parameters: { type: 'object', properties: {} },
  capabilities: ['order.read', 'world.assert'],
  riskClass: 'medium',
  surfaces: ['desk'],
  roles: ['manager', 'operator'],
  examples: ['investigate order DSP-1042', 'find backup chairs for the wedding order'],
  version: 1,
  ...overrides
});

const registry = (intents: Intent[]): IntentRegistry => ({ version: 1, intents });

describe('Scout lexical scoring', () => {
  it('tokenizes to lowercase stems without stopwords or one-letter fragments', () => {
    expect(tokenize('The INVESTIGATING orders, and a chair!')).toEqual([
      'investigat',
      'order',
      'chair'
    ]);
  });

  it('classifies scores at the documented band boundaries', () => {
    expect(bandFor(BANDS.high)).toBe('high');
    expect(bandFor(BANDS.high - 0.001)).toBe('medium');
    expect(bandFor(BANDS.medium)).toBe('medium');
    expect(bandFor(BANDS.low)).toBe('low');
    expect(bandFor(BANDS.low - 0.001)).toBe('reject');
  });

  it('splits clauses only when each side carries content', () => {
    expect(clauseSpans('investigate DSP-1042 and then find backup chairs')).toEqual([
      'investigate DSP-1042',
      'find backup chairs'
    ]);
    expect(clauseSpans('investigate DSP-1042, then find backup chairs')).toEqual([
      'investigate DSP-1042',
      'find backup chairs'
    ]);
  });

  it('scores the matching intent and never returns GENERAL', () => {
    const table = buildTriggerTable(
      registry([
        intent(),
        intent({
          id: 'GENERAL',
          description: 'anything',
          examples: ['investigate order'],
          capabilities: []
        })
      ])
    );
    const scores = scorePrompt('investigate order DSP-1042', table);
    expect(scores[0]).toMatchObject({ intent: 'order.investigate' });
    expect(scores[0]!.score).toBeGreaterThan(0);
    expect(scores.map((s) => s.intent)).not.toContain('GENERAL');
  });

  it('returns no candidates when nothing in the prompt matches', () => {
    const table = buildTriggerTable(registry([intent()]));
    expect(scorePrompt('completely unrelated words', table)).toEqual([]);
  });

  it('ranks a stronger match above a weaker one and honours k', () => {
    const table = buildTriggerTable(
      registry([
        intent(),
        intent({
          id: 'linen.investigate',
          description: 'Investigate linen',
          examples: ['investigate linen'],
          capabilities: []
        })
      ])
    );
    const scores = scorePrompt('investigate order DSP-1042 backup chairs', table, 1);
    expect(scores).toHaveLength(1);
    expect(scores[0]!.intent).toBe('order.investigate');
  });
});
