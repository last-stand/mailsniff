import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_TIMER_DELAY_MS, RefreshScheduler } from '../../../src/refresh/scheduler';
import type { SchedulerOptions } from '../../../src/refresh/scheduler';
import { createDeferred } from '../../helpers/deferred';

const MINUTE = 60_000;

function create(
  task: SchedulerOptions['task'],
  overrides: Partial<SchedulerOptions> = {},
): RefreshScheduler {
  return new RefreshScheduler({ intervalMs: MINUTE, task, jitterRatio: 0, ...overrides });
}

describe('RefreshScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('timing', () => {
    it('creates no timer until started', () => {
      vi.useFakeTimers();
      create(() => Promise.resolve(true));

      expect(vi.getTimerCount()).toBe(0);
    });

    it('runs after the initial delay and then once per interval', async () => {
      vi.useFakeTimers();
      const task = vi.fn(() => Promise.resolve(true));
      create(task).start(1000);

      await vi.advanceTimersByTimeAsync(999);
      expect(task).toHaveBeenCalledTimes(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);
    });

    it('start() is idempotent', () => {
      vi.useFakeTimers();
      const scheduler = create(() => Promise.resolve(true));
      scheduler.start(1000);
      scheduler.start(1000);

      expect(vi.getTimerCount()).toBe(1);
    });

    it('reports the next run time, and none while running or stopped', async () => {
      vi.useFakeTimers();
      const gate = createDeferred();
      const scheduler = create(async () => {
        await gate.promise;
        return true;
      });

      expect(scheduler.nextRunAt).toBeNull();
      scheduler.start(5000);
      expect(scheduler.nextRunAt).toBe(Date.now() + 5000);

      await vi.advanceTimersByTimeAsync(5000);
      expect(scheduler.nextRunAt).toBeNull();

      gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.nextRunAt).toBe(Date.now() + MINUTE);

      await scheduler.stop();
      expect(scheduler.nextRunAt).toBeNull();
    });
  });

  describe('jitter and limits', () => {
    it('spreads delays by the configured ratio', () => {
      vi.useFakeTimers();
      const low = create(() => Promise.resolve(true), { jitterRatio: 0.1, random: () => 0 });
      const high = create(() => Promise.resolve(true), { jitterRatio: 0.1, random: () => 1 });
      low.start(100_000);
      high.start(100_000);

      expect(low.nextRunAt).toBe(Date.now() + 90_000);
      expect(high.nextRunAt).toBe(Date.now() + 110_000);
    });

    it('never exceeds the setTimeout limit, even with jitter on the longest interval', () => {
      vi.useFakeTimers();
      const longest = 24 * 86_400_000;
      const scheduler = create(() => Promise.resolve(true), {
        intervalMs: longest,
        jitterRatio: 0.1,
        random: () => 1,
      });
      scheduler.start(longest);

      expect(scheduler.nextRunAt! - Date.now()).toBe(MAX_TIMER_DELAY_MS);
    });

    it('unrefs its timer so it never keeps the process alive', () => {
      const unref = vi.fn();
      vi.stubGlobal(
        'setTimeout',
        vi.fn(() => ({ unref })),
      );
      vi.stubGlobal('clearTimeout', vi.fn());
      const scheduler = create(() => Promise.resolve(true));

      scheduler.start(10);

      expect(unref).toHaveBeenCalledTimes(1);
    });
  });

  describe('failures', () => {
    it('retries with exponential backoff', async () => {
      vi.useFakeTimers();
      const task = vi.fn(() => Promise.resolve(false));
      create(task, { intervalMs: 3_600_000, initialBackoffMs: 1000 }).start(0);

      await vi.advanceTimersByTimeAsync(0);
      expect(task).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(999);
      expect(task).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(1999);
      expect(task).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(4000);
      expect(task).toHaveBeenCalledTimes(4);
    });

    it('never backs off for longer than the interval', async () => {
      vi.useFakeTimers();
      const task = vi.fn(() => Promise.resolve(false));
      create(task, { intervalMs: MINUTE, initialBackoffMs: 40_000 }).start(0);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      expect(task).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(3);
    });

    it('returns to the normal interval after a success', async () => {
      vi.useFakeTimers();
      const task = vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      create(task, { initialBackoffMs: 1000 }).start(0);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(task).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      expect(task).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(task).toHaveBeenCalledTimes(3);
    });

    it('treats a throwing task as a failure and keeps running', async () => {
      vi.useFakeTimers();
      const task = vi.fn(() => Promise.reject(new Error('boom')));
      create(task, { initialBackoffMs: 1000 }).start(0);

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);

      expect(task).toHaveBeenCalledTimes(2);
    });
  });

  describe('stop', () => {
    it('cancels the pending run', async () => {
      vi.useFakeTimers();
      const task = vi.fn(() => Promise.resolve(true));
      const scheduler = create(task);
      scheduler.start(1000);
      await scheduler.stop();

      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      expect(task).not.toHaveBeenCalled();
    });

    it('waits for a run in progress and does not reschedule afterwards', async () => {
      vi.useFakeTimers();
      const gate = createDeferred();
      const scheduler = create(async () => {
        await gate.promise;
        return true;
      });
      scheduler.start(0);
      await vi.advanceTimersByTimeAsync(0);

      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(stopped).toBe(false);

      gate.resolve();
      await stopping;

      expect(stopped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is idempotent and cannot be restarted', async () => {
      vi.useFakeTimers();
      const scheduler = create(() => Promise.resolve(true));
      scheduler.start(1000);
      await scheduler.stop();
      await scheduler.stop();
      scheduler.start(1000);

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
