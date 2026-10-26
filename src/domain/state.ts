import { InvalidStateTransitionError } from './errors';

export type OrderOperationalStatus = 'confirmed' | 'at_risk' | 'recovery_confirmed' | 'delivered';

export type RecoveryPlanStatus =
  | 'detected'
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'rejected'
  | 'stale'
  | 'incomplete'
  | 'failed';

const VALID_RECOVERY_TRANSITIONS: Record<RecoveryPlanStatus, RecoveryPlanStatus[]> = {
  detected: ['proposed', 'incomplete', 'failed', 'stale'],
  proposed: ['awaiting_approval', 'approved', 'rejected', 'stale', 'incomplete'],
  awaiting_approval: ['approved', 'rejected', 'stale'],
  approved: ['awaiting_confirmation', 'stale'],
  awaiting_confirmation: ['confirmed', 'stale', 'failed'],
  confirmed: ['stale'], // Even confirmed can become stale if underlying inventory is revised
  rejected: [],
  stale: ['proposed', 'awaiting_approval', 'incomplete'], // Re-investigation can propose a fresh plan
  incomplete: ['proposed', 'awaiting_approval', 'incomplete', 'failed'],
  failed: ['proposed', 'awaiting_approval', 'incomplete']
};

/**
 * Validates state transition according to the formal Dispatch recovery state machine.
 */
export function validateRecoveryTransition(
  current: RecoveryPlanStatus,
  target: RecoveryPlanStatus
): void {
  const allowed = VALID_RECOVERY_TRANSITIONS[current] ?? [];
  if (!allowed.includes(target)) {
    throw new InvalidStateTransitionError(
      `Cannot transition recovery plan from state '${current}' to '${target}'. Allowed transitions: [${allowed.join(', ')}]`
    );
  }
}

/**
 * Formats a machine status into truth-bearing human-readable UI text per DESIGN.md.
 */
export function formatRecoveryStatusLabel(
  status: RecoveryPlanStatus,
  requiresManagerApproval = true
): string {
  switch (status) {
    case 'detected':
      return 'Shortage detected';
    case 'proposed':
      return 'Recovery proposed';
    case 'awaiting_approval':
      return requiresManagerApproval ? 'Awaiting manager approval' : 'Awaiting approval';
    case 'approved':
      return 'Approved — not yet confirmed';
    case 'awaiting_confirmation':
      return 'Approved — not yet confirmed';
    case 'confirmed':
      return 'Recovery confirmed';
    case 'rejected':
      return 'Plan rejected';
    case 'stale':
      return 'Source changed — review required';
    case 'incomplete':
      return 'Investigation incomplete';
    case 'failed':
      return 'Investigation failed';
  }
}
