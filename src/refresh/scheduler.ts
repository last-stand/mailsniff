import { REFRESH_INITIAL_BACKOFF_MS, REFRESH_JITTER_RATIO } from '../constants';

/** Largest delay `setTimeout` accepts (2^31-1 ms); anything larger fires immediately. */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface SchedulerOptions {
  readonly intervalMs: number;
  /** Resolves `true` on success. A rejection counts as a failure. */
  readonly task: () => Promise<boolean>;
  readonly initialBackoffMs?: number;
  readonly jitterRatio?: number;
  readonly random?: () => number;
}

/**
 * Runs a task repeatedly with a chain of timeouts (never overlapping runs).
 * Failures retry with exponential backoff capped at the interval. Timers are unref'd,
 * so a pending refresh never keeps the process alive. A stopped scheduler is not restarted.
 */
export class RefreshScheduler {
  private readonly intervalMs: number;
  private readonly task: () => Promise<boolean>;
  private readonly initialBackoffMs: number;
  private readonly jitterRatio: number;
  private readonly random: () => number;

  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private stopped = false;
  private failures = 0;
  private nextAt: number | null = null;

  constructor(options: SchedulerOptions) {
    this.intervalMs = options.intervalMs;
    this.task = options.task;
    this.initialBackoffMs = options.initialBackoffMs ?? REFRESH_INITIAL_BACKOFF_MS;
    this.jitterRatio = options.jitterRatio ?? REFRESH_JITTER_RATIO;
    this.random = options.random ?? (() => Math.random());
  }

  /** Epoch milliseconds of the next run; `null` when stopped or while a run is in progress. */
  get nextRunAt(): number | null {
    return this.nextAt;
  }

  /** Idempotent. */
  start(initialDelayMs: number): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.schedule(initialDelayMs);
  }

  /** Cancels the pending run and waits for one that is in progress. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.nextAt = null;
    await this.running;
  }

  private schedule(delayMs: number): void {
    const jittered = this.withJitter(delayMs);
    this.nextAt = Date.now() + jittered;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, jittered);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    this.nextAt = null;

    let succeeded = false;
    try {
      succeeded = await this.task();
    } catch {
      succeeded = false;
    }

    this.failures = succeeded ? 0 : this.failures + 1;
    if (!this.stopped) {
      this.schedule(this.nextDelay(succeeded));
    }
  }

  private nextDelay(succeeded: boolean): number {
    if (succeeded) {
      return this.intervalMs;
    }
    const exponent = Math.min(this.failures - 1, 20);
    return Math.min(this.initialBackoffMs * 2 ** exponent, this.intervalMs);
  }

  private withJitter(delayMs: number): number {
    const spread = 1 - this.jitterRatio + 2 * this.jitterRatio * this.random();
    return Math.min(Math.round(delayMs * spread), MAX_TIMER_DELAY_MS);
  }
}
