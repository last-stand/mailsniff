export type MailSniffErrorCode =
  'CONFIG_ERROR' | 'VALIDATION_ERROR' | 'DATASET_ERROR' | 'CACHE_ERROR' | 'CLOSED_ERROR';

/** Base class for every error thrown by MailSniff. Use `code` for programmatic handling. */
export class MailSniffError extends Error {
  readonly code: MailSniffErrorCode;

  constructor(message: string, code: MailSniffErrorCode, options?: ErrorOptions) {
    super(message, options);
    this.name = 'MailSniffError';
    this.code = code;
  }
}

/** Invalid package options (for example a malformed refresh interval or Redis URL). */
export class ConfigError extends MailSniffError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CONFIG_ERROR', options);
    this.name = 'ConfigError';
  }
}

/** Invalid user input. `invalid` lists every rejected entry. */
export class ValidationError extends MailSniffError {
  readonly invalid: readonly string[];

  constructor(message: string, invalid: readonly string[] = [], options?: ErrorOptions) {
    super(message, 'VALIDATION_ERROR', options);
    this.name = 'ValidationError';
    this.invalid = Object.freeze([...invalid]);
  }
}

/** The remote dataset could not be fetched, or failed validation. */
export class DatasetError extends MailSniffError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'DATASET_ERROR', options);
    this.name = 'DatasetError';
  }
}

/** A cache backend operation failed (for example Redis is unreachable). */
export class CacheError extends MailSniffError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'CACHE_ERROR', options);
    this.name = 'CacheError';
  }
}

/** The instance was used after `close()`. */
export class ClosedError extends MailSniffError {
  constructor(message = 'This MailSniff instance has been closed', options?: ErrorOptions) {
    super(message, 'CLOSED_ERROR', options);
    this.name = 'ClosedError';
  }
}
