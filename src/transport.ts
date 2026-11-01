/**
 * How the SDK's messages reach your backend: by default over HTTPS, under the base URL your app
 * sets (the public guide, section 4).
 */

import { ApiException } from './errors';
import { isReleaseBuild } from './util/release';
import { normalizedTarget } from './util/target';

export type JsonObject = Record<string, unknown>;

export interface SendOptions {
  /** Sent exactly as given: it is what a request proof hashes. A GET sends no body. */
  encodedBody?: string | null;
  bearerToken?: string | null;
  headers?: Record<string, string>;
}

/**
 * Sends one request to your backend and answers its JSON object. A refusal is thrown as an
 * [ApiException] with the backend's `code`, `message` and `details` (the public guide, section 4,
 * Errors).
 */
export interface DeviceTrustTransport {
  send(method: string, path: string, options?: SendOptions): Promise<JsonObject>;
  close(): void;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * JSON over HTTPS under [baseUrl]. A release build refuses any other scheme, so a mistyped
 * endpoint fails loudly instead of sending tokens in the clear.
 */
export class HttpTransport implements DeviceTrustTransport {
  readonly baseUrl: string;
  /** How long one call may take, in milliseconds. */
  readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly running = new Set<AbortController>();
  private closed = false;

  constructor(baseUrl: string, options: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
    this.baseUrl = baseUrl;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private get base(): string {
    if (this.baseUrl.length === 0) {
      throw new ApiException('No API base URL was set for the backend.', { code: 'api_base_url_missing' });
    }
    if (isReleaseBuild() && !this.baseUrl.toLowerCase().startsWith('https://')) {
      throw new ApiException('The API base URL must be an https:// URL in a release build.', {
        code: 'api_base_url_insecure',
      });
    }
    return this.baseUrl.endsWith('/') ? this.baseUrl.substring(0, this.baseUrl.length - 1) : this.baseUrl;
  }

  async send(method: string, path: string, options: SendOptions = {}): Promise<JsonObject> {
    const url = `${this.base}${normalizedTarget(path)}`;
    if (this.closed) {
      throw new ApiException('HTTP connection failed: the transport is closed.');
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.bearerToken != null ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
      ...(options.headers ?? {}),
    };
    const controller = new AbortController();
    this.running.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: method === 'GET' ? undefined : options.encodedBody ?? '{}',
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      if (timedOut) {
        throw new ApiException('The server did not respond before the timeout.');
      }
      if (this.closed) {
        throw new ApiException('HTTP connection failed: the transport is closed.');
      }
      const words = error instanceof Error ? error.message : String(error);
      throw new ApiException(`Network connection failed: ${words}`);
    } finally {
      clearTimeout(timer);
      this.running.delete(controller);
    }

    let decoded: JsonObject = {};
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!isObject(parsed)) {
        throw new ApiException('The server returned a non-JSON response.', { statusCode: status });
      }
      decoded = parsed;
    }

    if (status < 200 || status >= 300) {
      const error = decoded['error'];
      const refusal = isObject(error) ? error : null;
      const details = refusal?.['details'];
      const message = refusal?.['message'];
      const code = refusal?.['code'];
      throw new ApiException(
        typeof message === 'string' ? message : `The server rejected the request (${status}).`,
        {
          statusCode: status,
          code: typeof code === 'string' ? code : undefined,
          details: isObject(details) ? details : undefined,
        },
      );
    }
    return decoded;
  }

  close(): void {
    this.closed = true;
    for (const controller of this.running) {
      controller.abort();
    }
    this.running.clear();
  }
}
