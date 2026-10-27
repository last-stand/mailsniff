import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from '../../../src/utils/timeout';

describe('withTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the value and leaves no timer behind', async () => {
    vi.useFakeTimers();

    await expect(withTimeout(Promise.resolve('ok'), 1000, () => new Error('late'))).resolves.toBe(
      'ok',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects with the created error when the promise is too slow', async () => {
    vi.useFakeTimers();

    const assertion = expect(
      withTimeout(new Promise<string>(() => undefined), 1000, () => new Error('too slow')),
    ).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the original rejection and clears the timer', async () => {
    vi.useFakeTimers();

    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('late')),
    ).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });
});
