/**
 * The step-up key (the public guide, section 3): a second key that the person must unlock, the
 * options it is made with, and its re-enrolment proof.
 */

import { NativeKeyException } from './errors';
import { base64UrlNoPadding, utf8Encode } from './util/bytes';
import { isObject, nativeFailure, stepUpKeyModule } from './util/native';
import { jwkThumbprint, orderedJwk, type PublicJwk } from './installationKey';

/**
 * The optional step-up key as the native side reports it. [factor], [mode] and [windowSeconds]
 * describe what the platform keystore actually enforces (read back from the key itself), which
 * on Android 9 and 10 is a short hardware window rather than per-use.
 */
export class StepUpKeyMetadata {
  readonly publicKey: PublicJwk;
  readonly factor: string;
  readonly mode: string;
  readonly windowSeconds: number;
  readonly securityLevel: string;
  readonly hardwareBacked: boolean;
  readonly created: boolean;

  constructor(value: {
    publicKey: PublicJwk;
    factor: string;
    mode: string;
    windowSeconds: number;
    securityLevel: string;
    hardwareBacked: boolean;
    created: boolean;
  }) {
    this.publicKey = value.publicKey;
    this.factor = value.factor;
    this.mode = value.mode;
    this.windowSeconds = value.windowSeconds;
    this.securityLevel = value.securityLevel;
    this.hardwareBacked = value.hardwareBacked;
    this.created = value.created;
  }

  get authJson(): Record<string, unknown> {
    return { factor: this.factor, mode: this.mode, window_seconds: this.windowSeconds };
  }

  get description(): string {
    return this.mode === 'per_use'
      ? `${this.factor}, per-use`
      : `${this.factor}, ${this.windowSeconds}s hardware window`;
  }

  /** RFC 7638 thumbprint, the same form the server derives from the JWK. */
  get thumbprint(): string {
    return jwkThumbprint(this.publicKey);
  }

  static fromPlatform(value: Record<string, unknown>): StepUpKeyMetadata {
    const rawPublicKey = value['public_key'];
    const rawAuth = value['auth'];
    if (!isObject(rawPublicKey) || !isObject(rawAuth)) {
      throw new TypeError('The native step-up key provider returned no public key or auth.');
    }
    const publicKey = orderedJwk(rawPublicKey);
    if (
      publicKey['kty'] !== 'EC' ||
      publicKey['crv'] !== 'P-256' ||
      publicKey['alg'] !== 'ES256' ||
      typeof publicKey['x'] !== 'string' ||
      typeof publicKey['y'] !== 'string'
    ) {
      throw new TypeError('The native step-up key provider did not return an EC P-256 public JWK.');
    }
    const factor = rawAuth['factor'];
    const mode = rawAuth['mode'];
    const window = rawAuth['window_seconds'];
    if (typeof factor !== 'string' || typeof mode !== 'string' || typeof window !== 'number' || !Number.isInteger(window)) {
      throw new TypeError('The native step-up key provider returned an invalid auth description.');
    }
    const securityLevel = value['security_level'];
    return new StepUpKeyMetadata({
      publicKey,
      factor,
      mode,
      windowSeconds: window,
      securityLevel: typeof securityLevel === 'string' ? securityLevel : 'unknown',
      hardwareBacked: value['hardware_backed'] === true,
      created: value['created'] === true,
    });
  }
}

/** Where a backend takes a re-enrolled step-up key by default (the public guide, section 4). */
export const stepUpReenrolPath = '/v1/installations/stepup-key';

/**
 * How the app wants its step-up key made (the public guide, section 3): [factor] `passcode` or
 * `biometric`; [mode] `per_use`, or `windowed` with [windowSeconds] from 1. Android 9 and 10 cannot
 * make a per-use passcode key and make a windowed one; iOS makes per-use keys only. [reenrolPath]
 * is where the backend takes a new key (DeviceTrust.reenrolStepUp).
 */
export class StepUpOptions {
  readonly factor: string;
  readonly mode: string;
  readonly windowSeconds: number;
  readonly reenrolPath: string;

  constructor(options: { factor?: string; mode?: string; windowSeconds?: number; reenrolPath?: string } = {}) {
    this.factor = options.factor ?? 'passcode';
    this.mode = options.mode ?? 'per_use';
    this.windowSeconds = options.windowSeconds ?? 0;
    this.reenrolPath = options.reenrolPath ?? stepUpReenrolPath;
  }

  /**
   * A key made with other values, or already made: whether it satisfies these options -- the same
   * factor (a backend refuses any other), and a per-use key or a window no longer than this one. A
   * per-use key satisfies windowed options.
   */
  accepts(key: StepUpKeyMetadata): boolean {
    return (
      key.factor === this.factor &&
      (key.mode === 'per_use' || (this.mode === 'windowed' && key.windowSeconds <= this.windowSeconds))
    );
  }

  get description(): string {
    return `${this.factor}, ${this.mode === 'per_use' ? 'per-use' : `${this.windowSeconds}s window`}`;
  }
}

/**
 * The proof a new step-up key signs at re-enrolment: the base64url of its JSON, the members in this
 * order. [nonce] is the request proof's nonce of the re-enrolment request.
 */
export function stepUpReenrolProof(args: {
  installationId: string;
  stepUpKeyThumbprint: string;
  nonce: string;
  timestamp: number;
}): string {
  return base64UrlNoPadding(
    utf8Encode(
      JSON.stringify({
        version: 1,
        purpose: 'stepup_reenrol',
        installation_id: args.installationId,
        stepup_key_thumbprint: args.stepUpKeyThumbprint,
        nonce: args.nonce,
        timestamp: args.timestamp,
      }),
    ),
  );
}

/**
 * Whether a step-up key [options] do not accept is replaced before the next registration: only
 * where the new key can then be bound -- by a re-enrolment ([replaceMismatched]), which binds it
 * with the person's re-authentication, or by this installation's first registration, which binds
 * the key it is offered. A known installation's registration never binds an offered key; it only
 * says whether it matches, so replacing the key there orphans the one the server holds: on a phone
 * that cannot make the key the options ask for (Android 9 makes no per-use passcode key), the
 * registration that follows every re-enrolment would replace the key the server had just bound,
 * and step-up would stay unavailable.
 */
export function replacesStepUpKey(
  key: StepUpKeyMetadata,
  options: StepUpOptions,
  flags: { replaceMismatched: boolean; knownInstallation: boolean },
): boolean {
  return !key.created && !options.accepts(key) && (flags.replaceMismatched || !flags.knownInstallation);
}

const STEPUP_MODULE_MISSING = (): NativeKeyException =>
  new NativeKeyException(
    'NATIVE_STEPUP_PLUGIN_MISSING',
    "The SDK's step-up key module is not linked into this app: rebuild the app.",
  );

export class NativeStepUpKey {
  /** The mode the app asks for, which decides whether a windowed key first tries to sign inside an open hardware window. */
  configuredMode: string;

  constructor(options: { configuredMode?: string } = {}) {
    this.configuredMode = options.configuredMode ?? 'per_use';
  }

  /**
   * Returns the existing key as the keystore enforces it, or creates one with these values: an
   * existing key is never changed, so a caller that needs other values deletes it first.
   */
  async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    const native = stepUpKeyModule();
    if (native === null) {
      throw STEPUP_MODULE_MISSING();
    }
    let value: unknown;
    try {
      value = await native.getOrCreateKey(args.factor, args.mode, args.windowSeconds);
    } catch (error) {
      throw nativeFailure(error, 'The native step-up key provider failed.');
    }
    if (!isObject(value)) {
      throw new NativeKeyException('EMPTY_NATIVE_RESPONSE', 'The native step-up key provider returned no key metadata.');
    }
    return StepUpKeyMetadata.fromPlatform(value);
  }

  /** Shows the system passcode (or biometric) prompt and completes when the person answers it. A cancelled prompt is STEPUP_CANCELLED. */
  async sign(payloadBase64Url: string, options: { reason: string }): Promise<string> {
    const native = stepUpKeyModule();
    if (native === null) {
      throw STEPUP_MODULE_MISSING();
    }
    let signature: unknown;
    try {
      signature = await native.sign(payloadBase64Url, options.reason, this.configuredMode);
    } catch (error) {
      throw nativeFailure(error, 'The step-up key could not sign.');
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new NativeKeyException('EMPTY_NATIVE_SIGNATURE', 'The step-up key returned no signature.');
    }
    return signature;
  }

  async deleteKey(): Promise<void> {
    const native = stepUpKeyModule();
    if (native === null) {
      throw STEPUP_MODULE_MISSING();
    }
    try {
      await native.deleteKey();
    } catch (error) {
      throw nativeFailure(error, 'The step-up key could not be deleted.');
    }
  }
}
