import type { ResponseLike } from '../../src/dataset/fetcher';

export interface FakeResponseInit {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Record<string, string>;
  /** Split the body into chunks of this many bytes. */
  readonly chunkSize?: number;
  /** Simulate a response without a readable stream. */
  readonly noStream?: boolean;
}

export interface FakeResponse extends ResponseLike {
  readonly state: { cancelled: boolean };
}

/** A fresh response per call: a stream can only be read once. */
export function makeResponse(init: FakeResponseInit = {}): FakeResponse {
  const status = init.status ?? 200;
  const text = init.body ?? '';
  const headers = new Map(
    Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
  );

  const encoded = new TextEncoder().encode(text);
  const chunkSize = init.chunkSize ?? Math.max(encoded.length, 1);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    chunks.push(encoded.slice(offset, offset + chunkSize));
  }

  const state = { cancelled: false };
  let index = 0;

  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    body: init.noStream
      ? null
      : {
          getReader: () => ({
            read: () => {
              const value = chunks[index];
              index += 1;
              return Promise.resolve(value ? { done: false, value } : { done: true });
            },
            cancel: () => {
              state.cancelled = true;
              return Promise.resolve();
            },
          }),
        },
    text: () => Promise.resolve(text),
    state,
  };
}
