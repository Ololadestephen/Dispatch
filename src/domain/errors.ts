/**
 * Typed domain errors for deterministic calculations, quote verification, and state transitions.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InconsistentInventoryError extends DomainError {
  constructor(message: string) {
    super(message, 'INCONSISTENT_INVENTORY');
    this.name = 'InconsistentInventoryError';
  }
}

export class InvalidDeadlineError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_DEADLINE');
    this.name = 'InvalidDeadlineError';
  }
}

export class UnauthorizedApprovalError extends DomainError {
  constructor(message: string) {
    super(message, 'UNAUTHORIZED_APPROVAL');
    this.name = 'UnauthorizedApprovalError';
  }
}

export class InvalidStateTransitionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_STATE_TRANSITION');
    this.name = 'InvalidStateTransitionError';
  }
}

export class VersionConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'VERSION_CONFLICT');
    this.name = 'VersionConflictError';
  }
}

export class UnresolvedQuoteError extends DomainError {
  constructor(message: string) {
    super(message, 'UNRESOLVED_QUOTE');
    this.name = 'UnresolvedQuoteError';
  }
}

export class ModelOutageError extends DomainError {
  constructor(message: string) {
    super(message, 'MODEL_OUTAGE');
    this.name = 'ModelOutageError';
  }
}

export class ModelBudgetExceededError extends DomainError {
  constructor(message: string) {
    super(message, 'MODEL_BUDGET_EXCEEDED');
    this.name = 'ModelBudgetExceededError';
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_REQUEST');
    this.name = 'InvalidRequestError';
  }
}
