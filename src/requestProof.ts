/**
 * Request proofs (the public guide, section 3): the installation key signs each request, so a
 * copied session token is useless without the key; with step-up on the person approves one
 * request with the step-up key, and with the app PIN on a request carries the backend's proof of
 * the PIN. Also the description of the one request a scan is to approve (section 2).
 */

import { NativeKeyException } from './errors';
import { base64UrlDecode, base64UrlNoPadding, sha256Hex, utf8Encode } from './util/bytes';
import { storageModule, nativeFailure } from './util/native';
import { parseTarget } from './util/target';
import type { InstallationIdentity } from './installationKey';

export { base64UrlNoPadding } from './util/bytes';

/** Where [freshNonce] takes its bytes: the platform's secure random source, replaced in tests. */
export let secureRandomBytes: (count: number) => Promise<Uint8Array> = async (count: number) => {
  const native = storageModule();
  if (native === null) {
    throw new NativeKeyException(
      'NATIVE_STORAGE_PLUGIN_MISSING',
      "The SDK's storage module is not linked into this app: rebuild the app.",
    );
  }
  let encoded: string;
  try {
    encoded = await native.randomBytes(count);
  } catch (error) {
    throw nativeFailure(error, 'The platform gave no random bytes.');
  }
  const bytes = base64UrlDecode(encoded);
  if (bytes.length !== count) {
    throw new NativeKeyException('RANDOM_BYTES_SHORT', `The platform gave ${bytes.length} random bytes of ${count}.`);
  }
  return bytes;
};

/** Replaces the secure random source -- for tests, which run where no phone is. */
export function setSecureRandomSource(source: (count: number) => Promise<Uint8Array>): void {
  secureRandomBytes = source;
}

/** 32 random bytes from the platform's secure source. */
export function freshNonce(): Promise<Uint8Array> {
  return secureRandomBytes(32);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The person's approval of one request: the step-up key's [factor], and [sign], which has the
 * step-up key sign a payload -- the phone asks the person (NativeStepUpKey.sign).
 */
export interface StepUpApproval {
  factor: string;
  sign: (payload: string) => Promise<string>;
}

export interface RequestProofFields {
  bearerToken: string;
  method: string;
  path: string;
  encodedBody: string;
  payload: string;
  signature: string;
  timestamp: number;
  nonce: string;
  stepUpPayload?: string | null;
  stepUpSignature?: string | null;
  appPinProof?: string | null;
  integrityReport?: string | null;
}

/**
 * What the installation key signed for one request -- with step-up, what the step-up key signed;
 * with the app PIN, the backend's proof of it; for a request a scan approves, that scan's report --
 * and the headers that carry them beside `Authorization: Bearer`.
 */
export class RequestProof {
  readonly bearerToken: string;
  /** The request the proof was signed for: its method, its path with the query, and the exact body. */
  readonly method: string;
  readonly path: string;
  readonly encodedBody: string;
  /** `X-Access-Proof`: the base64url of the proof's JSON bytes. */
  readonly payload: string;
  /** `X-Access-Signature`. */
  readonly signature: string;
  readonly timestamp: number;
  readonly nonce: string;
  /** `X-Step-Up-Proof` and `X-Step-Up-Signature`, for a request the person approved. */
  readonly stepUpPayload: string | null;
  readonly stepUpSignature: string | null;
  /** `X-App-PIN-Proof`: the backend's proof that the person entered the app PIN for this request. */
  readonly appPinProof: string | null;
  /** `X-Integrity-Report`: the report of the scan made for this request alone (the public guide, section 2). */
  readonly integrityReport: string | null;

  constructor(fields: RequestProofFields) {
    this.bearerToken = fields.bearerToken;
    this.method = fields.method;
    this.path = fields.path;
    this.encodedBody = fields.encodedBody;
    this.payload = fields.payload;
    this.signature = fields.signature;
    this.timestamp = fields.timestamp;
    this.nonce = fields.nonce;
    this.stepUpPayload = fields.stepUpPayload ?? null;
    this.stepUpSignature = fields.stepUpSignature ?? null;
    this.appPinProof = fields.appPinProof ?? null;
    this.integrityReport = fields.integrityReport ?? null;
  }

  get headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Access-Proof': this.payload,
      'X-Access-Signature': this.signature,
    };
    if (this.stepUpPayload !== null) headers['X-Step-Up-Proof'] = this.stepUpPayload;
    if (this.stepUpSignature !== null) headers['X-Step-Up-Signature'] = this.stepUpSignature;
    if (this.appPinProof !== null) headers['X-App-PIN-Proof'] = this.appPinProof;
    if (this.integrityReport !== null) headers['X-Integrity-Report'] = this.integrityReport;
    return headers;
  }

  /** This request, unlocked by the backend's [proof] of the app PIN. */
  withAppPinProof(proof: string): RequestProof {
    return this.with(proof, this.integrityReport);
  }

  /** This request, naming [reportId], the scan made for it alone. */
  withIntegrityReport(reportId: string): RequestProof {
    return this.with(this.appPinProof, reportId);
  }

  private with(appPinProof: string | null, integrityReport: string | null): RequestProof {
    return new RequestProof({
      bearerToken: this.bearerToken,
      method: this.method,
      path: this.path,
      encodedBody: this.encodedBody,
      payload: this.payload,
      signature: this.signature,
      timestamp: this.timestamp,
      nonce: this.nonce,
      stepUpPayload: this.stepUpPayload,
      stepUpSignature: this.stepUpSignature,
      appPinProof,
      integrityReport,
    });
  }
}

/**
 * What the app sends to have its backend check the app PIN for one request: the PIN, and that
 * request as its request proof signs it -- method, path, query, the hash of the body sent and the
 * request proof's nonce.
 */
export function appPinProofRequest(args: {
  pin: string;
  method: string;
  path: string;
  encodedBody: string;
  nonce: string;
}): Record<string, unknown> {
  const target = parseTarget(args.path);
  return {
    pin: args.pin,
    request: {
      method: args.method.toUpperCase(),
      path: target.path,
      query: target.query,
      body_sha256: sha256Hex(args.encodedBody),
      nonce: args.nonce,
    },
  };
}

/**
 * The step-up proof, version 2, that the step-up key signs for one request: the base64url of its
 * JSON, the members in this order. [nonce] is the request proof's nonce for the same request, so
 * the approval is used up with it.
 */
export function stepUpProof(args: {
  installationId: string;
  accessToken: string;
  method: string;
  path: string;
  encodedBody: string;
  factor: string;
  nonce: string;
  timestamp: number;
}): string {
  const target = parseTarget(args.path);
  return base64UrlNoPadding(
    utf8Encode(
      JSON.stringify({
        version: 2,
        purpose: 'stepup',
        installation_id: args.installationId,
        access_token_sha256: sha256Hex(args.accessToken),
        method: args.method.toUpperCase(),
        path: target.path,
        query: target.query,
        body_sha256: sha256Hex(args.encodedBody),
        factor: args.factor,
        nonce: args.nonce,
        timestamp: args.timestamp,
      }),
    ),
  );
}

/**
 * Signs [method] [path] with [encodedBody] under [bearerToken]: proof version 2, which signs the
 * query string too, exactly as sent. A GET signs an empty body. With [stepUp], the step-up key signs
 * first -- the phone asks the person -- and the request proof after, with the same nonce, so the
 * time the person takes does not count against the request proof's clock window.
 * [installationId], [timestamp] and [nonce] replace what the request proof would otherwise carry,
 * for the shared test vectors and for testing a backend's refusals.
 */
export async function signRequest(args: {
  identity: InstallationIdentity;
  method: string;
  path: string;
  bearerToken: string;
  encodedBody?: string;
  stepUp?: StepUpApproval | null;
  installationId?: string | null;
  timestamp?: number | null;
  nonce?: Uint8Array | readonly number[] | null;
}): Promise<RequestProof> {
  const normalizedMethod = args.method.toUpperCase();
  const body = normalizedMethod === 'GET' ? '' : args.encodedBody ?? '';
  const nonceText = base64UrlNoPadding(args.nonce ?? (await freshNonce()));
  let stepUpPayload: string | null = null;
  let stepUpSignature: string | null = null;
  if (args.stepUp != null) {
    stepUpPayload = stepUpProof({
      installationId: args.identity.installationId,
      accessToken: args.bearerToken,
      method: normalizedMethod,
      path: args.path,
      encodedBody: body,
      factor: args.stepUp.factor,
      nonce: nonceText,
      timestamp: nowSeconds(),
    });
    stepUpSignature = await args.stepUp.sign(stepUpPayload);
  }
  const signedAt = args.timestamp ?? nowSeconds();
  const target = parseTarget(args.path);
  // The members in this order: the backend checks each against the request it received, and the
  // shared vectors hold both sides to these bytes.
  const proof = {
    access_token_sha256: sha256Hex(args.bearerToken),
    body_sha256: sha256Hex(body),
    installation_id: args.installationId ?? args.identity.installationId,
    method: normalizedMethod,
    nonce: nonceText,
    path: target.path,
    query: target.query,
    timestamp: signedAt,
    version: 2,
  };

  // The key signs the exact JSON bytes this base64url value carries; the private key never leaves
  // the phone's keystore.
  const payload = base64UrlNoPadding(utf8Encode(JSON.stringify(proof)));
  return new RequestProof({
    bearerToken: args.bearerToken,
    method: normalizedMethod,
    path: args.path,
    encodedBody: body,
    payload,
    signature: await args.identity.signPayload(payload),
    timestamp: signedAt,
    nonce: nonceText,
    stepUpPayload,
    stepUpSignature,
  });
}

/** The one request a scan is to approve, described exactly as it will be sent: what the challenge names as its `operation`. */
export function describeOperation(method: string, path: string, encodedBody: string): Record<string, unknown> {
  const target = parseTarget(path);
  return {
    method: method.toUpperCase(),
    path: target.path,
    query: target.query,
    body_sha256: sha256Hex(encodedBody),
  };
}
