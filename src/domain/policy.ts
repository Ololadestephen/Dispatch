import { UnauthorizedApprovalError } from './errors';

export type UserRole = 'manager' | 'operator';

export interface UserSession {
  userId: string;
  name: string;
  role: UserRole;
}

export interface ApprovalPolicy {
  policyId: string;
  name: string;
  thresholdKobo: number; // e.g. 50,000 NGN = 5_000_000 kobo
  currency: 'NGN';
}

/**
 * Standard policy from PRD:
 * Extra emergency spend above 50,000 NGN requires manager approval.
 */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = {
  policyId: 'POL-EMERGENCY-SPEND-50K',
  name: 'Emergency Spend Approval Policy',
  thresholdKobo: 5_000_000, // 50,000 NGN
  currency: 'NGN'
};

export interface ApprovalRequirementResult {
  amountKobo: number;
  thresholdKobo: number;
  requiresManagerApproval: boolean;
  explanation: string;
}

/**
 * Evaluates whether an expenditure requires manager sign-off.
 */
export function evaluateApprovalRequirement(
  amountKobo: number,
  policy: ApprovalPolicy = DEFAULT_APPROVAL_POLICY
): ApprovalRequirementResult {
  if (!Number.isInteger(amountKobo) || amountKobo < 0) {
    throw new Error(
      `Amount must be a non-negative integer in minor units (kobo). Received: ${amountKobo}`
    );
  }

  const requiresManagerApproval = amountKobo > policy.thresholdKobo;
  const formattedAmount = formatNaira(amountKobo);
  const formattedThreshold = formatNaira(policy.thresholdKobo);

  const explanation = requiresManagerApproval
    ? `Cost ${formattedAmount} exceeds emergency spend threshold of ${formattedThreshold}. Manager approval required.`
    : `Cost ${formattedAmount} is within pre-approved threshold of ${formattedThreshold}. Operator may proceed.`;

  return {
    amountKobo,
    thresholdKobo: policy.thresholdKobo,
    requiresManagerApproval,
    explanation
  };
}

/**
 * Enforces role-based authorization for an approval mutation.
 */
export function verifyApprovalAuthorization(
  actor: UserSession,
  requirement: ApprovalRequirementResult
): void {
  if (requirement.requiresManagerApproval && actor.role !== 'manager') {
    throw new UnauthorizedApprovalError(
      `Action requires 'manager' role due to spend (${formatNaira(requirement.amountKobo)} > ${formatNaira(requirement.thresholdKobo)}). User '${actor.name}' has role '${actor.role}'.`
    );
  }
}

/**
 * Formats minor units (kobo) to clean Naira representation.
 * Example: 9000000 -> "₦90,000"
 */
export function formatNaira(kobo: number): string {
  const naira = Math.floor(kobo / 100);
  const remainderKobo = Math.abs(kobo % 100);
  const formattedWhole = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    minimumFractionDigits: remainderKobo > 0 ? 2 : 0,
    maximumFractionDigits: 2
  }).format(naira + remainderKobo / 100);

  return formattedWhole;
}
