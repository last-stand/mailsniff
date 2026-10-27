import { DatasetError } from '../errors';
import { errorMessage } from '../utils/error';

const USER_AGENT = 'mailsniff (+https://github.com/last-stand/mailsniff)';

/** The subset of the Fetch `Response` that MailSniff uses (keeps tests free of globals). */
export interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<unknown>;
    };
  } | null;
  text(): Promise<string>;
}

/** Compatible with the global `fetch` of Node.js 18+. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<ResponseLike>;

export interface FetchDatasetOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  /** Sent as `If-None-Match`; a `304` then resolves to `not-modified`. */
  readonly etag?: string;
  readonly fetch?: FetchLike;
}

export type FetchDatasetResult =
  | { readonly status: 'modified'; readonly body: string; readonly etag?: string }
  | { readonly status: 'not-modified' };

async function readBodyText(response: ResponseLike, maxBytes: number): Promise<string> {
  const tooLarge = (): DatasetError =>
    new DatasetError(`Dataset response is too large (limit ${maxBytes} bytes)`);

  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw tooLarge();
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  }

  // TextDecoder strips a leading UTF-8 BOM.
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

async function interpretResponse(
  response: ResponseLike,
  options: FetchDatasetOptions,
): Promise<FetchDatasetResult> {
  if (response.status === 304) {
    if (options.etag) {
      return { status: 'not-modified' };
    }
    throw new DatasetError('Dataset source answered 304 Not Modified to an unconditional request');
  }

  if (!response.ok) {
    throw new DatasetError(`Dataset source responded with HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
    throw new DatasetError(`Dataset response is too large (limit ${options.maxBytes} bytes)`);
  }

  const body = await readBodyText(response, options.maxBytes);
  const etag = response.headers.get('etag') ?? undefined;
  return { status: 'modified', body, etag };
}

function toDatasetError(error: unknown, timedOut: boolean, timeoutMs: number): DatasetError {
  if (error instanceof DatasetError) {
    return error;
  }
  if (timedOut) {
    return new DatasetError(`Timed out after ${timeoutMs}ms while fetching the dataset`, {
      cause: error,
    });
  }
  return new DatasetError(`Failed to fetch the dataset: ${errorMessage(error)}`, { cause: error });
}

/**
 * Downloads the blocklist with a hard timeout and size limit.
 * Every failure is reported as a {@link DatasetError}.
 */
export async function fetchDataset(options: FetchDatasetOptions): Promise<FetchDatasetResult> {
  const fetchImpl = options.fetch ?? (globalThis as unknown as { fetch?: FetchLike }).fetch;
  if (typeof fetchImpl !== 'function') {
    throw new DatasetError(
      'No fetch implementation is available. Use Node.js 18+ or pass `dataset.fetch`.',
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs);

  try {
    const headers: Record<string, string> = { accept: 'text/plain', 'user-agent': USER_AGENT };
    if (options.etag) {
      headers['if-none-match'] = options.etag;
    }

    const response = await fetchImpl(options.url, { headers, signal: controller.signal });
    return await interpretResponse(response, options);
  } catch (error) {
    throw toDatasetError(error, controller.signal.aborted, options.timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}
