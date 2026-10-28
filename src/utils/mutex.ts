const ignore = (): void => undefined;

/** Runs async tasks strictly one at a time, in call order. A failing task does not block the next. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(ignore, ignore);
    return result;
  }
}
