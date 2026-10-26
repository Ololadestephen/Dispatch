/**
 * Types for Dispatch's implementation of the Meterless Scout Intent specification
 * (vendor/meterless/scout-intent, Apache-2.0). Shapes follow AGENTS.md and docs/*.md there.
 */

export type RiskClass = 'low' | 'medium' | 'high';
export type RiskLevel = RiskClass | 'block';
export type LayerVerdict = 'pass' | 'warn' | 'block';
export type Band = 'high' | 'medium' | 'low' | 'reject';

export interface ParameterProperty {
  type?: 'integer' | 'number' | 'string' | 'boolean' | 'array' | 'object';
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface Intent {
  id: string;
  category: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ParameterProperty>;
    required?: string[];
  };
  capabilities: string[];
  riskClass: RiskClass;
  surfaces: string[];
  roles: string[];
  examples: string[];
  version: number;
}

export interface IntentRegistry {
  version: number;
  intents: Intent[];
}

export interface UserRef {
  id: string;
  role: string;
}

export interface IntentCandidate {
  intent: string;
  score: number;
  span?: string;
}

export interface RiskFlag {
  layer: 'injection' | 'policy' | 'scope' | 'sensitivity' | 'rate-limit';
  verdict: LayerVerdict;
  kind: string;
  /** Exact substrings of the input that triggered the flag (payloads are not logged elsewhere). */
  evidence: string[];
  reason: string;
}

export interface Redaction {
  dataClass: 'email' | 'phone' | 'card' | 'credential';
  start: number;
  end: number;
}

export interface Risk {
  level: RiskLevel;
  flags: RiskFlag[];
  redactions: Redaction[];
  reason?: string;
  approvalsRequired?: Array<{ kind: 'user-confirm' | 'operator-review' }>;
}

export interface ToolStep {
  capability: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface Clarification {
  question: string;
  trigger: 'low-band' | 'tie' | 'params' | 'high-risk';
  options: Array<{ label: string; intent: string }>;
}

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  intent: {
    primary: { id: string; version: number };
    parameters: Record<string, unknown>;
    references: Record<string, string>;
    confidence: number;
    alternates: IntentCandidate[];
  };
  risk: { level: RiskClass; flags: RiskFlag[]; redactions: Redaction[]; approvals: unknown[] };
  toolPlan: ToolStep[];
  modelProfile: { id: string };
  scope: { user: UserRef; surface: string; capabilities: string[] };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  policyPackVersion: string;
  signature: string;
  signedBy: 'scout';
}

export interface Decision {
  traceId: string;
  candidates: IntentCandidate[];
  band: Band;
  intent: string;
  intents?: string[];
  parameters: Record<string, unknown>;
  risk: Risk;
  toolPlan: ToolStep[];
  clarification?: Clarification;
  executionContract?: ExecutionContract;
}
