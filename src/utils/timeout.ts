/**
 * Rejects with `createError()` if `promise` has not settled within `ms`.
 * The timer is always cleared, so it can never keep the process alive.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  createError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(createError());
    }, ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
