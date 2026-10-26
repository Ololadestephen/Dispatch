import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDeadline } from '../../src/application/workflowDeadline';

afterEach(() => vi.useRealTimers());
describe('Investigation workflow deadline', () => {
  it('times out work that ignores cancellation and keeps later persistence checks closed', async () => {
    vi.useFakeTimers();
    const scope = new WorkflowDeadline(20);
    let resolve: (value: string) => void = () => {};
    const work = new Promise<string>((done) => {
      resolve = done;
    });
    const rejection = expect(scope.run(() => work)).rejects.toMatchObject({
      code: 'WORKFLOW_TIMEOUT'
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    resolve('late result');
    expect(() => scope.check()).toThrow(/deadline/);
    scope.dispose();
  });

  it('cancels from the caller and does not start another operation', async () => {
    const caller = new AbortController();
    const scope = new WorkflowDeadline(1000, caller.signal);
    caller.abort();
    const operation = vi.fn();
    await expect(scope.run(operation)).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(operation).not.toHaveBeenCalled();
    scope.dispose();
  });

  it('checks elapsed time even if a busy event loop has not fired the timer', () => {
    let now = 0;
    const scope = new WorkflowDeadline(20, undefined, () => now);
    now = 21;
    expect(() => scope.check()).toThrow(/deadline/);
    scope.dispose();
  });
});
