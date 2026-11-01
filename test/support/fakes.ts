// The phone's native side and a backend, replaced: a backend that answers as the public guide says,
// and the key, store, collector, hint reader and step-up key the tests need.
import {
  ApiException,
  DeviceTrust,
  InstallationIdentity,
  InstallationStore,
  NativeInstallationKey,
  NativeIntegrityCollector,
  NativeKeyException,
  NativeKeyMetadata,
  NativeStepUpKey,
  ReinstallHint,
  ReinstallHintReader,
  StepUpKeyMetadata,
  type AppPinOptions,
  type DeviceTrustTransport,
  type JsonObject,
  type PersonalMeasurement,
  type RequestProof,
  type SendOptions,
  type StepUpOptions,
} from '../../src';
import { base64UrlDecode, utf8Decode } from '../../src/util/bytes';

export interface Call {
  method: string;
  path: string;
  body: JsonObject;
  bearer: string | null;
  headers: Record<string, string>;
}

/** Answers each path from its queue, the last answer repeating; an ApiException in the queue is thrown. */
export class Backend implements DeviceTrustTransport {
  readonly answers: Record<string, unknown[]>;
  readonly calls: Call[] = [];

  constructor(answers: Record<string, unknown[]> = {}) {
    this.answers = {
      '/v1/installations/register': [{ installation_id: 'proposed-id' }],
      '/v1/installations/challenge': [{ challenge_id: 'key-challenge', payload: 'cGF5' }],
      '/v1/installations/verify': [{ device_token: 'installation-session' }],
      '/v1/integrity/challenge': [
        {
          challenge_id: 'scan-challenge',
          nonce: 'bm9uY2U',
          platform: 'android',
          required_probes: ['app_identity'],
          optional_probes: ['location'],
        },
      ],
      '/v1/integrity/report': [{ integrity: { report_id: 'report-1' } }],
      '/v1/account/app-pin': [{ app_pin_set: true }],
      '/v1/account/app-pin/proof': [{ app_pin_proof: 'pin-proof' }],
      '/v1/installations/stepup-key': [{ stepup_key_registered: true }],
      ...answers,
    };
  }

  get paths(): string[] {
    return this.calls.map((call) => call.path);
  }

  async send(method: string, path: string, options: SendOptions = {}): Promise<JsonObject> {
    const encodedBody = options.encodedBody ?? null;
    this.calls.push({
      method,
      path,
      body: encodedBody === null || encodedBody.length === 0 ? {} : (JSON.parse(encodedBody) as JsonObject),
      bearer: options.bearerToken ?? null,
      headers: options.headers ?? {},
    });
    const queue = this.answers[path];
    if (queue === undefined) {
      throw new Error(`no answer for ${path}`);
    }
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof ApiException) {
      throw next;
    }
    return { ...(next as JsonObject) };
  }

  close(): void {}
}

/** Answers as [Backend] does, but holds the answer to [held] until [gate] resolves. */
export class HeldBackend extends Backend {
  readonly held: string;
  readonly gate: Promise<void>;
  private askedResolve: () => void = () => {};
  readonly asked: Promise<void>;

  constructor(held: string, gate: Promise<void>, answers: Record<string, unknown[]> = {}) {
    super(answers);
    this.held = held;
    this.gate = gate;
    this.asked = new Promise((resolve) => (this.askedResolve = resolve));
  }

  override async send(method: string, path: string, options: SendOptions = {}): Promise<JsonObject> {
    if (path === this.held) {
      this.askedResolve();
      await this.gate;
    }
    return super.send(method, path, options);
  }
}

/** A promise and the function that settles it. */
export function completer<T = void>(): { promise: Promise<T>; complete: (value: T) => void; fail: (error: unknown) => void } {
  let complete: (value: T) => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const promise = new Promise<T>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  return { promise, complete, fail };
}

export function metadata(created = false): NativeKeyMetadata {
  return new NativeKeyMetadata({
    publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', x: 'x', y: 'y' },
    algorithm: 'ES256',
    keyAlias: 'test',
    provider: 'AndroidKeyStore',
    securityLevel: 'trusted_execution_environment',
    hardwareBacked: true,
    privateKeyExportable: false,
    signatureFormat: 'der',
    created,
  });
}

export class Key extends NativeInstallationKey {
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    return metadata();
  }
  override async signPayload(): Promise<string> {
    return 'signed';
  }
  override async deleteKey(): Promise<void> {}
}

export class Store extends InstallationStore {
  saved: string | null = null;
  reenrolPending = false;

  constructor() {
    super({ key: new Key() });
  }

  override async loadOrCreate(): Promise<InstallationIdentity> {
    return new InstallationIdentity({ installationId: 'proposed-id', nativeKey: this.key, metadata: metadata() });
  }

  override async saveInstallationId(installationId: string): Promise<void> {
    this.saved = installationId;
  }

  override async stepUpReenrolPending(): Promise<boolean> {
    return this.reenrolPending;
  }

  override async setStepUpReenrolPending(pending: boolean): Promise<void> {
    this.reenrolPending = pending;
  }

  override async clear(): Promise<void> {
    this.saved = null;
    this.reenrolPending = false;
  }
}

export class Collector extends NativeIntegrityCollector {
  enabled: string[] | null = null;

  override async collect(args: {
    requiredProbes: string[];
    challengeNonce: string;
    enabledMeasurements: string[];
    optionalProbes?: string[];
  }): Promise<Record<string, unknown>> {
    this.enabled = args.enabledMeasurements;
    const probes: Record<string, unknown> = {};
    for (const probe of args.requiredProbes) {
      probes[probe] = { status: 'ok' };
    }
    return { platform: 'android', challenge_nonce_echo: args.challengeNonce, collector_version: 8, probes };
  }
}

export class Hints extends ReinstallHintReader {
  override async read(): Promise<ReinstallHint | null> {
    return new ReinstallHint({ kind: 'android_id_sha256', value: 'hint' });
  }
}

export class StepUpKey extends NativeStepUpKey {
  readonly refuse: NativeKeyException | null;
  reason: string | null = null;

  constructor(refuse: NativeKeyException | null = null) {
    super();
    this.refuse = refuse;
  }

  override async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    if (this.refuse !== null) {
      throw this.refuse;
    }
    return new StepUpKeyMetadata({
      publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', x: 'sx', y: 'sy' },
      factor: args.factor,
      mode: args.mode,
      windowSeconds: args.windowSeconds,
      securityLevel: 'trusted_execution_environment',
      hardwareBacked: true,
      created: true,
    });
  }

  override async sign(_payload: string, options: { reason: string }): Promise<string> {
    this.reason = options.reason;
    return 'approved';
  }

  override async deleteKey(): Promise<void> {}
}

/** A key that died with the screen lock: its first signature fails, and a new one is made once it is deleted. */
export class DyingStepUpKey extends StepUpKey {
  deleted = 0;

  override async sign(payload: string, options: { reason: string }): Promise<string> {
    if (this.deleted === 0) {
      throw new NativeKeyException('STEPUP_KEY_INVALIDATED', 'the lock was removed');
    }
    return super.sign(payload, options);
  }

  override async deleteKey(): Promise<void> {
    this.deleted += 1;
  }
}

/** A key the keystore cannot vouch for (STEPUP_KEY_UNAVAILABLE) until it is replaced. */
export class UnavailableStepUpKey extends StepUpKey {
  deleted = 0;

  override async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    if (this.deleted === 0) {
      throw new NativeKeyException('STEPUP_KEY_UNAVAILABLE', 'the keystore could not say whether the key is usable');
    }
    return super.getOrCreateKey(args);
  }

  override async deleteKey(): Promise<void> {
    this.deleted += 1;
  }
}

/** A dying key whose first prompt after its replacement is cancelled. */
export class CancelledStepUpKey extends DyingStepUpKey {
  cancelled = false;

  override async sign(payload: string, options: { reason: string }): Promise<string> {
    if (this.deleted > 0 && !this.cancelled) {
      this.cancelled = true;
      throw new NativeKeyException('STEPUP_CANCELLED', 'the person cancelled');
    }
    return super.sign(payload, options);
  }
}

/** Refuses the first key it is asked for, then makes one. */
export class FlakyStepUpKey extends StepUpKey {
  attempts = 0;

  override async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new NativeKeyException('STEPUP_NO_DEVICE_CREDENTIAL', 'no screen lock yet');
    }
    return super.getOrCreateKey(args);
  }
}

export function trustOver(
  backend: DeviceTrustTransport,
  options: {
    store?: InstallationStore;
    collector?: NativeIntegrityCollector;
    stepUpKey?: NativeStepUpKey;
    personal?: Iterable<PersonalMeasurement>;
    stepUp?: StepUpOptions | null;
    appPin?: AppPinOptions | null;
    onRegistered?: (answer: JsonObject) => void;
  } = {},
): DeviceTrust {
  return DeviceTrust.over(backend, {
    personalMeasurements: options.personal ?? [],
    stepUp: options.stepUp ?? null,
    appPin: options.appPin ?? null,
    onRegistered: options.onRegistered ?? null,
    store: options.store ?? new Store(),
    collector: options.collector ?? new Collector(),
    hintReader: new Hints(),
    stepUpKey: options.stepUpKey ?? new StepUpKey(),
  });
}

export function decoded(payload: string): Record<string, any> {
  return JSON.parse(utf8Decode(base64UrlDecode(payload)));
}

export function refusal(code: string, status: number, details?: Record<string, unknown>): ApiException {
  return new ApiException(code, { statusCode: status, code, details });
}

/** One approval with the step-up key, for a payment. */
export function approve(trust: DeviceTrust): Promise<RequestProof> {
  return trust.signRequest({ method: 'POST', path: '/v1/pay', bearer: 'account-session', stepUp: true });
}

/** Whether [promise] fails with a NativeKeyException of [code]. */
export async function expectNativeCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(NativeKeyException);
  await promise.catch((error: NativeKeyException) => expect(error.code).toBe(code));
}

export const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
