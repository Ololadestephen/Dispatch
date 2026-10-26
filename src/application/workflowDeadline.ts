import { DomainError } from '../domain/errors';

/** Wall-clock execution budget, separate from the frozen business scenario clock. */
export class WorkflowDeadline {
  private readonly controller = new AbortController();
  private readonly expiresAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly onParentAbort = () =>
    this.controller.abort(
      new DomainError('Investigation request was cancelled.', 'REQUEST_CANCELLED')
    );

  constructor(
    timeoutMs: number,
    private readonly parent?: AbortSignal,
    private readonly now: () => number = () => performance.now()
  ) {
    this.expiresAt = now() + timeoutMs;
    this.timer = setTimeout(() => this.expire(), timeoutMs);
    parent?.addEventListener('abort', this.onParentAbort, { once: true });
    if (parent?.aborted) this.onParentAbort();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  private expire(): void {
    this.controller.abort(
      new DomainError('Investigation exceeded its workflow deadline.', 'WORKFLOW_TIMEOUT')
    );
  }

  /** Call immediately before any persistence; a late result must never commit. */
  check(): void {
    if (this.now() >= this.expiresAt && !this.signal.aborted) this.expire();
    this.signal.throwIfAborted();
  }

  async run<T>(operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    this.check();
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          this.check();
          return operation(this.signal);
        }),
        aborted
      ]);
      this.check();
      return value;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener('abort', this.onParentAbort);
  }
}
