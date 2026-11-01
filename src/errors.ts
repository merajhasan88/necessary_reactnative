/** The failures the SDK reports. */

/**
 * A failure of the phone's keystore or of a prompt: [code] says which -- `KEY_UNAVAILABLE` (the
 * keystore could not be reached for the installation key; no key was made over it: try again, or
 * reset()), `STEPUP_KEY_INVALIDATED` (the key can never sign again: re-enrol),
 * `STEPUP_KEY_UNAVAILABLE` (the keystore could not say whether the key is usable, or could not be
 * reached; it was kept: try again, or re-enrol), `STEPUP_CANCELLED`, `STEPUP_REENROL_PENDING` and
 * the like -- and [message] says it in words, followed by everything that failed beneath it
 * (`[cause: ...]`) down to the keystore's own answer wherever the phone gives one.
 */
export class NativeKeyException extends Error {
  /** What failed, for the app to act on. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'NativeKeyException';
    this.code = code;
  }

  override toString(): string {
    return `${this.message} [${this.code}]`;
  }
}

/**
 * A refusal from your backend, or a request that did not reach it: the backend's
 * `{"error": {"code", "message", "details"}}` (the guide, section 4), with the HTTP status.
 */
export class ApiException extends Error {
  /** The HTTP status, when the backend answered. */
  readonly statusCode?: number;

  /** The backend's `code`: what the app acts on. */
  readonly code?: string;

  /** The backend's `details`, such as `retry_after_seconds`. */
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: { statusCode?: number; code?: string; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'ApiException';
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
  }

  override toString(): string {
    return this.message;
  }
}

/**
 * A call that DeviceTrust.reset or DeviceTrust.close ended while it ran: what it found belongs to
 * an installation that is gone, or to a client that is closed, so nothing of it was kept. After a
 * reset, call again.
 */
export class InterruptedCallException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterruptedCallException';
  }

  override toString(): string {
    return this.message;
  }
}
