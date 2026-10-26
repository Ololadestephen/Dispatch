import crypto from 'node:crypto';
import { loadRegistry } from './registry';
import {
  bandFor,
  buildTriggerTable,
  clauseSpans,
  scorePrompt,
  selfTestLatency,
  BANDS
} from './scoring';
import { guard, POLICY_PACK_VERSIONS, RateLimiter } from './guard';
import { CONTRACT_TTL_MS, signContract, ulid, verifyContract } from './contract';
import type {
  Clarification,
  Decision,
  ExecutionContract,
  Intent,
  IntentCandidate,
  IntentRegistry,
  ToolStep,
  UserRef
} from './types';

export type * from './types';
export { verifyContract, ContractRefusedError } from './contract';

/**
 * Dispatch's implementation of the Meterless Scout Intent specification
 * (vendor/meterless/scout-intent, commit 1742dec, Apache-2.0). Stage-1 rules only: no model call.
 * Verified against the vendored eval harness with `npm run eval:scout`.
 */

export interface ToolRegistration {
  capability: string;
  toolId: string;
  local: boolean;
  available?: () => boolean;
}

export interface ScoutOptions {
  intentRegistry: string | IntentRegistry;
  policyPack?: string | string[];
  /** Model profiles for the Recommend stage; the first entry is used (no routing among models yet). */
  modelProfiles?: Array<{ id: string }>;
  /** HMAC secret. Defaults to $SCOUT_SIGNING_SECRET, else a random per-process secret. */
  signingSecret?: string;
  /**
   * 'registered-only': a capability needs a registered tool (production).
   * 'identity': an unregistered capability resolves to a virtual tool of the same name (eval harness).
   */
  capabilityResolution?: 'registered-only' | 'identity';
  /** Surfaces whose text is data, not a request; the untrusted-content pack applies there. */
  untrustedSurfaces?: string[];
  now?: () => number;
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fifteen: 15,
  twenty: 20
};

export class Scout {
  readonly registry: IntentRegistry;
  readonly policyPackVersion: string;
  private readonly packs: string[];
  private readonly table: ReturnType<typeof buildTriggerTable>;
  private readonly tools = new Map<string, ToolRegistration[]>();
  private readonly secret: string;
  private readonly resolution: 'registered-only' | 'identity';
  private readonly untrustedSurfaces: Set<string>;
  private readonly modelProfile: { id: string };
  private readonly rateLimiter = new RateLimiter();
  private readonly now: () => number;
  private readonly issued = new Map<string, ExecutionContract>();

  constructor(options: ScoutOptions) {
    this.registry = loadRegistry(options.intentRegistry);
    this.packs = [options.policyPack ?? 'default'].flat();
    for (const p of this.packs) {
      if (!POLICY_PACK_VERSIONS[p]) throw new Error(`Unknown Scout policy pack "${p}".`);
    }
    this.policyPackVersion = this.packs.map((p) => POLICY_PACK_VERSIONS[p]).join('+');
    this.table = buildTriggerTable(this.registry);
    selfTestLatency(this.table, this.registry);
    this.secret =
      options.signingSecret ??
      process.env.SCOUT_SIGNING_SECRET ??
      crypto.randomBytes(32).toString('hex');
    this.resolution = options.capabilityResolution ?? 'identity';
    this.untrustedSurfaces = new Set(options.untrustedSurfaces ?? []);
    this.modelProfile = options.modelProfiles?.[0] ?? { id: 'none' };
    this.now = options.now ?? Date.now;
  }

  /** Capability graph registration (docs/capability-graph.md). */
  readonly capabilities = {
    register: (reg: ToolRegistration) => {
      this.tools.set(reg.capability, [...(this.tools.get(reg.capability) ?? []), reg]);
    }
  };

  async classify(input: {
    prompt: string;
    surface: string;
  }): Promise<{ candidates: IntentCandidate[] }> {
    return { candidates: scorePrompt(input.prompt, this.table) };
  }

  async decide(input: {
    prompt: string;
    user?: UserRef;
    surface: string;
    context?: unknown;
  }): Promise<Decision> {
    const traceId = crypto.randomUUID();
    const user = input.user ?? { id: 'anonymous', role: 'viewer' };
    const untrusted = this.untrustedSurfaces.has(input.surface);
    const packs = untrusted ? [...this.packs, 'untrusted-content'] : this.packs;

    // Untrusted content is screened, never classified into an action.
    const candidates = untrusted ? [] : scorePrompt(input.prompt, this.table);
    const top = candidates[0];
    const band = top ? bandFor(top.score) : 'reject';
    const general = this.intentById('GENERAL')!;
    const primary = !top || band === 'reject' ? general : this.intentById(top.intent)!;

    const risk = guard({
      prompt: input.prompt,
      intent: primary,
      user,
      surface: input.surface,
      packs,
      rateLimitOk: this.rateLimiter.take(`${user.id}:${primary.id}`, this.now())
    });
    const parameters = this.bindParameters(input.prompt, primary);
    const intents = this.multiIntent(input.prompt);
    const base: Decision = {
      traceId,
      candidates,
      band,
      intent: primary.id,
      ...(intents ? { intents } : {}),
      parameters,
      risk,
      toolPlan: []
    };
    if (risk.level === 'block') return base;

    const clarification = this.clarification(candidates, band, primary, parameters);
    if (clarification) return { ...base, clarification };

    const toolPlan = this.route(primary, parameters, user);
    const contract = this.issue({
      primary,
      parameters,
      prompt: input.prompt,
      confidence: top?.score ?? 0,
      candidates,
      risk,
      toolPlan,
      user,
      surface: input.surface,
      traceId
    });
    return { ...base, toolPlan, executionContract: contract };
  }

  /** Re-planning with lineage: a fresh contract for the same decision, parentId set, same traceId. */
  async replan(input: {
    parent: string;
    reason: string;
    state?: unknown;
  }): Promise<ExecutionContract> {
    const parent = this.issued.get(input.parent);
    if (!parent) throw new Error(`Unknown parent contract ${input.parent}.`);
    const { signature: _s, signedBy: _b, ...rest } = parent;
    const nowMs = this.now();
    return this.remember(
      signContract(
        {
          ...rest,
          contractId: ulid(nowMs),
          parentId: parent.contractId,
          issuedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + CONTRACT_TTL_MS).toISOString()
        },
        this.secret
      )
    );
  }

  /** Executor-side check that every downstream call must pass. */
  verify(contract: ExecutionContract, capability: string): void {
    verifyContract(contract, this.secret, { capability, nowMs: this.now() });
  }

  private intentById(id: string): Intent | undefined {
    return this.registry.intents.find((i) => i.id === id);
  }

  private bindParameters(prompt: string, intent: Intent): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const lower = prompt.toLowerCase();
    for (const [name, prop] of Object.entries(intent.parameters.properties)) {
      if (prop.enum) {
        const hit = prop.enum.find((v) => new RegExp(`\\b${v.toLowerCase()}s?\\b`).test(lower));
        if (hit) out[name] = hit;
      } else if (prop.type === 'integer' || prop.type === 'number') {
        const m =
          lower.match(/\b(\d{1,4})\b/) ??
          lower.match(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`));
        const value = m ? Number(m[1]) || NUMBER_WORDS[m[1]!] : undefined;
        if (
          value !== undefined &&
          (prop.minimum === undefined || value >= prop.minimum) &&
          (prop.maximum === undefined || value <= prop.maximum)
        ) {
          out[name] = value;
        }
      }
    }
    return out;
  }

  private multiIntent(prompt: string): string[] | undefined {
    const spans = clauseSpans(prompt);
    if (spans.length < 2) return undefined;
    const tops = spans
      .map((span) => ({ span, top: scorePrompt(span, this.table)[0] }))
      .filter((s): s is { span: string; top: IntentCandidate } =>
        Boolean(s.top && s.top.score >= BANDS.medium)
      );
    const ids = [...new Set(tops.map((t) => t.top.intent))];
    return ids.length >= 2 ? ids : undefined;
  }

  private clarification(
    candidates: IntentCandidate[],
    band: string,
    intent: Intent,
    parameters: Record<string, unknown>
  ): Clarification | undefined {
    const options = candidates
      .slice(0, 4)
      .map((c) => ({ label: this.intentById(c.intent)!.description, intent: c.intent }));
    if (band === 'low')
      return { question: 'Which of these did you mean?', trigger: 'low-band', options };
    const [a, b] = candidates;
    if (band === 'medium' && a && b && a.score - b.score < 0.05) {
      return { question: 'These two fit equally well. Which one?', trigger: 'tie', options };
    }
    const missing = (intent.parameters.required ?? []).filter((p) => parameters[p] === undefined);
    if (missing.length) {
      return { question: `Missing: ${missing.join(', ')}.`, trigger: 'params', options: [] };
    }
    if (intent.riskClass === 'high' && (a?.score ?? 0) < 0.95) {
      return { question: `Confirm you want ${intent.id}.`, trigger: 'high-risk', options };
    }
    return undefined;
  }

  /** Route stage: permissions/availability, then local-first tie-break. */
  private route(intent: Intent, parameters: Record<string, unknown>, user: UserRef): ToolStep[] {
    return intent.capabilities.map((capability) => {
      const usable = (this.tools.get(capability) ?? []).filter((t) => t.available?.() ?? true);
      const chosen = usable.sort((x, y) => Number(y.local) - Number(x.local))[0];
      if (!chosen && this.resolution === 'registered-only') {
        throw new Error(`Capability ${capability} has no available tool; ${intent.id} cannot run.`);
      }
      return {
        capability,
        tool: chosen?.toolId ?? capability,
        input: { ...parameters, requestedBy: user.id }
      };
    });
  }

  private issue(d: {
    primary: Intent;
    parameters: Record<string, unknown>;
    prompt: string;
    confidence: number;
    candidates: IntentCandidate[];
    risk: Decision['risk'];
    toolPlan: ToolStep[];
    user: UserRef;
    surface: string;
    traceId: string;
  }): ExecutionContract {
    const nowMs = this.now();
    const references = Object.fromEntries(
      [...d.prompt.matchAll(/\b[A-Z]{2,}-\d+\b/g)].map((m, i) => [`ref${i + 1}`, m[0]])
    );
    return this.remember(
      signContract(
        {
          contractId: ulid(nowMs),
          traceId: d.traceId,
          intent: {
            primary: { id: d.primary.id, version: d.primary.version },
            parameters: d.parameters,
            references,
            confidence: d.confidence,
            alternates: d.candidates.slice(1)
          },
          risk: {
            level: d.risk.level === 'block' ? 'high' : d.risk.level,
            flags: d.risk.flags,
            redactions: d.risk.redactions,
            approvals: []
          },
          toolPlan: d.toolPlan,
          modelProfile: this.modelProfile,
          scope: { user: d.user, surface: d.surface, capabilities: d.primary.capabilities },
          issuedAt: new Date(nowMs).toISOString(),
          expiresAt: new Date(nowMs + CONTRACT_TTL_MS).toISOString(),
          registryVersion: this.registry.version,
          policyPackVersion: this.policyPackVersion
        },
        this.secret
      )
    );
  }

  private remember(contract: ExecutionContract): ExecutionContract {
    this.issued.set(contract.contractId, contract);
    return contract;
  }
}
