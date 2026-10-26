import type { Intent, Redaction, Risk, RiskFlag, RiskLevel, UserRef } from './types';

/**
 * Guard stage (docs/risk-and-policy.md): five independent layers, each pass / warn / block.
 * Policy packs are code here (implementer's choice); their versions are stamped on contracts.
 *
 * Packs:
 * - default            known injection patterns, role drift, embedded control markup, RBAC/surface.
 * - adversarial-tight  adds hidden-markup and invisible-character checks and mass-action tool refs.
 * - untrusted-content  for text that is DATA, not a request (e.g. a supplier message): any
 *                      sentence asking the system to change state is an injected instruction.
 */
export const POLICY_PACK_VERSIONS: Record<string, string> = {
  default: 'default@1',
  'adversarial-tight': 'adversarial-tight@1',
  'untrusted-content': 'untrusted-content@1'
};

interface PatternRule {
  kind: string;
  pattern: RegExp;
}

const DEFAULT_PATTERNS: PatternRule[] = [
  {
    kind: 'instruction-override',
    pattern:
      /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|all|any|your|the)\b[^.\n]{0,20}?\b(?:instructions?|rules?|prompts?|guidelines?|polic(?:y|ies)|directives?|constraints?)\b/i
  },
  {
    // "Ignore previous and …", "disregard the user": overriding the principal without naming rules.
    kind: 'principal-override',
    pattern:
      /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\b(?!\s+(?:email|message|meeting|quarter|version|order)s?\b)|\b(?:ignore|disregard)\s+(?:the|your)\s+(?:user|operator|system|developer)\b/i
  },
  {
    kind: 'privilege-escalation',
    pattern:
      /\b(?:grant|give|make|elevate|promote)\b[^.\n]{0,20}\b(?:admin(?:istrator)?|root|superuser|sudo|owner)\b(?:\s+(?:access|rights|role|privileges?))?|\belevate\b[^.\n]{0,20}\bprivileges?\b/i
  },
  {
    kind: 'secret-exfiltration',
    pattern:
      /\b(?:reveal|print|show|list|dump|leak|send|export)\b[^.\n]{0,30}\b(?:credentials?|passwords?|api[ -]?keys?|secrets?|access tokens?|private keys?)\b/i
  },
  {
    kind: 'role-drift',
    pattern:
      /\b(?:you are now|from now on,? you|pretend (?:to be|you are)|act as (?:an? |the )?(?:admin|administrator|root|system|developer|unrestricted)|(?:developer|god|unrestricted|jailbreak|dan|sudo) mode)\b/i
  },
  {
    kind: 'embedded-control',
    pattern:
      /<\/?\s*(?:system|assistant|developer)\s*>|\[\/?INST\]|<\|im_(?:start|end)\|>|^\s*#{2,}\s*(?:system|instruction)/im
  },
  {
    kind: 'prompt-exfiltration',
    pattern:
      /\b(?:reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\b(?:system prompt|hidden (?:prompt|instructions)|your instructions)\b/i
  }
];

const TIGHT_PATTERNS: PatternRule[] = [
  { kind: 'hidden-markup', pattern: /<!--[\s\S]*?-->|\]\(\s*javascript:|<\s*(?:script|iframe)\b/i },
  { kind: 'invisible-characters', pattern: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/ },
  {
    // The same bidi / zero-width code points written as escape sequences or HTML entities.
    kind: 'invisible-characters',
    pattern:
      /\\u(?:200[b-f]|202[a-e]|206[0-9]|feff)\b|&#x?(?:8203|8206|8207|8234|8235|8236|8237|8238|200b|202e);/i
  }
];

/** "use <tool_name>": an explicit tool or panel reference, checked against the capability graph. */
const TOOL_MENTION =
  /\b(?:use|call|invoke|run|open)\s+(?:the\s+)?([a-z][a-z0-9]*(?:[_.][a-z0-9]+)+)\b/i;

/** Act verbs mapped to the capability family they would need (docs/capability-graph.md families). */
const ACT_VERBS: Array<{ verb: RegExp; capabilityPrefix: string[] }> = [
  {
    verb: /\b(?:email|send|mail|message|notify)\b/i,
    capabilityPrefix: ['email.send', 'slack.post']
  },
  {
    verb: /\b(?:delete|remove|drop|wipe|purge)\b/i,
    capabilityPrefix: ['world.assert', 'file.write']
  },
  { verb: /\b(?:pay|transfer|wire|refund|charge)\b/i, capabilityPrefix: ['payment.'] },
  { verb: /\b(?:export|dump|download)\b/i, capabilityPrefix: ['file.write', 'world.export'] }
];
const MASS_TARGET =
  /\b(?:every|all)\s+(?:customers?|accounts?|users?|contacts?|records?|deals?)\b/i;

/** State-changing requests in untrusted text ("mark order X as delivered", "cancel the order"). */
const STATE_CHANGE_REQUEST =
  /\b(?:mark|set|update|change|close|cancel|delete|approve|confirm|send|pay|transfer|refund)\b[^.!?\n]{0,80}\b(?:order|status|system|record|account|payment|invoice|delivered|shipped|complete[d]?)\b/i;

const PII: Array<{ dataClass: Redaction['dataClass']; pattern: RegExp }> = [
  { dataClass: 'email', pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { dataClass: 'phone', pattern: /\+?\d[\d\s-]{8,}\d/g },
  { dataClass: 'card', pattern: /\b(?:\d[ -]?){13,16}\b/g },
  { dataClass: 'credential', pattern: /\b(?:sk|nvapi|ghp|xox[bp])[-_][A-Za-z0-9-_]{16,}\b/g }
];

function sentenceAround(text: string, index: number): string {
  const start =
    Math.max(
      text.lastIndexOf('.', index),
      text.lastIndexOf('!', index),
      text.lastIndexOf('?', index)
    ) + 1;
  const ends = ['.', '!', '?'].map((c) => text.indexOf(c, index)).filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) : text.length;
  return text.slice(start, end).trim();
}

function injectionLayer(prompt: string, intent: Intent | undefined, packs: string[]): RiskFlag[] {
  const rules = [
    ...DEFAULT_PATTERNS,
    ...(packs.includes('adversarial-tight') ? TIGHT_PATTERNS : [])
  ];
  const flags: RiskFlag[] = [];
  for (const rule of rules) {
    const m = rule.pattern.exec(prompt);
    if (m) {
      flags.push({
        layer: 'injection',
        verdict: 'block',
        kind: rule.kind,
        evidence: [m[0]],
        reason: `Injection pattern: ${rule.kind}`
      });
    }
  }

  // Out-of-band tool refs: a named tool the matched intent's capabilities cannot reach.
  const toolMention = TOOL_MENTION.exec(prompt);
  if (toolMention && !intent?.capabilities.includes(toolMention[1]!.toLowerCase())) {
    flags.push({
      layer: 'injection',
      verdict: 'block',
      kind: 'tool-ref',
      evidence: [toolMention[0]],
      reason: `References tool "${toolMention[1]}" outside the intent's capabilities`
    });
  }

  // Out-of-band tool refs: a mass action whose capability the matched intent cannot reach.
  if (packs.includes('adversarial-tight') && MASS_TARGET.test(prompt)) {
    for (const { verb, capabilityPrefix } of ACT_VERBS) {
      const m = verb.exec(prompt);
      const reachable = intent?.capabilities.some((c) =>
        capabilityPrefix.some((p) => c.startsWith(p))
      );
      if (m && !reachable) {
        flags.push({
          layer: 'injection',
          verdict: 'block',
          kind: 'tool-ref',
          evidence: [sentenceAround(prompt, m.index)],
          reason: `Requests a mass "${m[0]}" action outside the intent's capabilities`
        });
        break;
      }
    }
  }

  if (packs.includes('untrusted-content')) {
    const re = new RegExp(STATE_CHANGE_REQUEST.source, 'gi');
    for (let m = re.exec(prompt); m; m = re.exec(prompt)) {
      flags.push({
        layer: 'injection',
        verdict: 'block',
        kind: 'embedded-instruction',
        evidence: [sentenceAround(prompt, m.index)],
        reason: 'Untrusted content asks the system to change state'
      });
    }
  }
  return flags;
}

function policyLayer(intent: Intent | undefined, user: UserRef, surface: string): RiskFlag[] {
  if (!intent || intent.id === 'GENERAL') return [];
  const roleOk = intent.roles.includes('*') || intent.roles.includes(user.role);
  const surfaceOk = intent.surfaces.includes(surface);
  const flags: RiskFlag[] = [];
  if (!roleOk) {
    flags.push({
      layer: 'policy',
      verdict: intent.riskClass === 'high' ? 'block' : 'warn',
      kind: 'role-not-allowed',
      evidence: [],
      reason: `Role "${user.role}" is not allowed for ${intent.id}`
    });
  }
  if (!surfaceOk) {
    flags.push({
      layer: 'scope',
      verdict: 'warn',
      kind: 'surface-mismatch',
      evidence: [],
      reason: `${intent.id} is not registered for surface "${surface}"`
    });
  }
  return flags;
}

function sensitivityLayer(prompt: string): { flags: RiskFlag[]; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  for (const { dataClass, pattern } of PII) {
    for (const m of prompt.matchAll(pattern)) {
      redactions.push({ dataClass, start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    }
  }
  const credential = redactions.some((r) => r.dataClass === 'credential');
  return {
    redactions,
    flags: credential
      ? [
          {
            layer: 'sensitivity',
            verdict: 'block',
            kind: 'credential',
            evidence: [],
            reason: 'Prompt contains a credential'
          }
        ]
      : []
  };
}

/** Per user and intent token bucket (implementer's choice: 30 decisions per minute). */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute = 30) {}

  take(key: string, nowMs: number): boolean {
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: nowMs };
    b.tokens = Math.min(this.perMinute, b.tokens + ((nowMs - b.at) / 60_000) * this.perMinute);
    b.at = nowMs;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    return ok;
  }
}

const LIFT: Record<RiskLevel, RiskLevel> = {
  low: 'medium',
  medium: 'high',
  high: 'high',
  block: 'block'
};

/** Reduces the five layers to one Risk per the spec's reduction rules. */
export function guard(params: {
  prompt: string;
  intent: Intent | undefined;
  user: UserRef;
  surface: string;
  packs: string[];
  rateLimitOk: boolean;
}): Risk {
  const { prompt, intent, user, surface, packs, rateLimitOk } = params;
  const sensitivity = sensitivityLayer(prompt);
  const flags = [
    ...injectionLayer(prompt, intent, packs),
    ...policyLayer(intent, user, surface),
    ...sensitivity.flags,
    ...(rateLimitOk
      ? []
      : [
          {
            layer: 'rate-limit' as const,
            verdict: 'block' as const,
            kind: 'rate-limit',
            evidence: [],
            reason: 'Rate limit exceeded'
          }
        ])
  ];

  const blocking = flags.find((f) => f.verdict === 'block');
  if (blocking) {
    return { level: 'block', flags, redactions: sensitivity.redactions, reason: blocking.reason };
  }
  let level: RiskLevel = intent?.riskClass ?? 'low';
  for (const f of flags) if (f.verdict === 'warn') level = LIFT[level];
  const approvalsRequired =
    intent?.riskClass === 'high' && level !== 'low'
      ? [{ kind: 'user-confirm' as const }]
      : undefined;
  return { level, flags, redactions: sensitivity.redactions, approvalsRequired };
}
