export interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

export function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Lets pending promise callbacks run. Uses a real macrotask, so do not use it with fake `setImmediate`. */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
