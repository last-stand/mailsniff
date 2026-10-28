import { describe, expect, it } from 'vitest';
import { Mutex } from '../../../src/utils/mutex';
import { createDeferred } from '../../helpers/deferred';

describe('Mutex', () => {
  it('runs tasks one at a time, in call order', async () => {
    const mutex = new Mutex();
    const gate = createDeferred();
    const events: string[] = [];

    const first = mutex.runExclusive(async () => {
      events.push('first:start');
      await gate.promise;
      events.push('first:end');
    });
    const second = mutex.runExclusive(() => {
      events.push('second');
      return Promise.resolve();
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(events).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('returns each task’s value', async () => {
    const mutex = new Mutex();

    await expect(mutex.runExclusive(() => Promise.resolve(42))).resolves.toBe(42);
  });

  it('propagates a failure to its caller without blocking later tasks', async () => {
    const mutex = new Mutex();
    const failing = mutex.runExclusive(() => Promise.reject(new Error('boom')));
    const next = mutex.runExclusive(() => Promise.resolve('still works'));

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('still works');
  });
});
