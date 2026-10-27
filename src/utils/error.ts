/** Normalizes anything that was thrown into an `Error` instance. */
export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
