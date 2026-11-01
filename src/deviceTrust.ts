/**
 * DeviceTrust: the one object an app configures -- its backend, the personal measurements it
 * enables, step-up and the app PIN -- and what it asks of it: start, scan, and sign a request (the
 * public guide).
 */

import { DeviceTrustClient } from './client';
import { NativeIntegrityCollector } from './collector';
import { ApiException, InterruptedCallException, NativeKeyException } from './errors';
import type { InstallationIdentity } from './installationKey';
import { InstallationStore } from './installationStore';
import { protocolStepFor, protocolWait, ProtocolStep } from './protocol';
import { ReinstallHintReader, type ReinstallHint } from './reinstallHint';
import { collectReport, type ScanChallenge, type SignedReport } from './report';
import {
  base64UrlNoPadding,
  freshNonce,
  RequestProof,
  signRequest as signRequestProof,
  type StepUpApproval,
} from './requestProof';
import { NativeStepUpKey, stepUpReenrolProof, StepUpKeyMetadata, StepUpOptions } from './stepUpKey';
import { HttpTransport, type DeviceTrustTransport, type JsonObject } from './transport';

/**
 * The personal measurements an app may enable (the public guide, section 8). Each is collected
 * only when the backend asks for it as well -- the location only with the person's permission too.
 */
export const PersonalMeasurement = {
  localAddresses: 'local_addresses',
  accessibility: 'accessibility',
  notificationAccess: 'notification_access',
  otherAccess: 'other_access',
  screenCapture: 'screen_capture',
  location: 'location',
  mockLocation: 'mock_location',
} as const;

/** The name the report and the backend use for one personal measurement. */
export type PersonalMeasurement = (typeof PersonalMeasurement)[keyof typeof PersonalMeasurement];

/** Every personal measurement, in the guide's order. */
export const personalMeasurements: readonly PersonalMeasurement[] = Object.values(PersonalMeasurement);

/** Where the backend takes the app PIN's two calls (the public guide, section 4). */
export class AppPinOptions {
  readonly path: string;
  readonly proofPath: string;

  constructor(options: { path?: string; proofPath?: string } = {}) {
    this.path = options.path ?? DeviceTrustClient.appPinPath;
    this.proofPath = options.proofPath ?? DeviceTrustClient.appPinProofPath;
  }
}

/** One scan: the challenge it answered, the report as signed, and the backend's answer, whole. */
export class ScanResult {
  readonly challenge: ScanChallenge;
  readonly report: SignedReport;
  readonly answer: JsonObject;

  constructor(value: { challenge: ScanChallenge; report: SignedReport; answer: JsonObject }) {
    this.challenge = value.challenge;
    this.report = value.report;
    this.answer = value.answer;
  }

  /** The stored report (`integrity.report_id`), which a scan made for one request sends back with that request. */
  get reportId(): string | null {
    const integrity = this.answer['integrity'];
    const id = typeof integrity === 'object' && integrity !== null ? (integrity as JsonObject)['report_id'] : null;
    return typeof id === 'string' ? id : null;
  }
}

export interface DeviceTrustOptions {
  /** What this app enables; the backend asks for what it needs of them. */
  personalMeasurements?: Iterable<PersonalMeasurement>;
  /** How the step-up key is made, or null for no step-up. */
  stepUp?: StepUpOptions | null;
  /** The app PIN's calls, or null for no app PIN. */
  appPin?: AppPinOptions | null;
  /** Every registration's answer, whole, awaited before the installation goes on. */
  onRegistered?: ((answer: JsonObject) => void | Promise<void>) | null;
}

/** The same, with the parts tests replace. */
export interface DeviceTrustParts extends DeviceTrustOptions {
  store?: InstallationStore;
  collector?: NativeIntegrityCollector;
  hintReader?: ReinstallHintReader;
  stepUpKey?: NativeStepUpKey;
  /** The phone's platform, `android` or `ios`, for the registration. */
  platform?: () => string;
}

function settled(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export class DeviceTrust {
  /** The guide's calls, for an app that makes them itself. */
  readonly client: DeviceTrustClient;

  /**
   * What this app enables; the backend asks for what it needs of them. The app may change it
   * whenever the person does -- in a privacy setting, say: the next scan measures what it holds
   * then, and the installation, its session and its step-up key stay as they are.
   */
  personalMeasurements: Set<PersonalMeasurement>;

  /** How the step-up key is made, or null for no step-up. An app that takes these from its backend sets them before [start]. */
  stepUp: StepUpOptions | null;

  /** The app PIN's calls, or null for no app PIN. */
  readonly appPin: AppPinOptions | null;

  /**
   * Every registration's answer, whole -- also those made again inside a scan, when the backend had
   * lost the installation -- awaited before the installation goes on.
   */
  readonly onRegistered: ((answer: JsonObject) => void | Promise<void>) | null;

  private readonly store: InstallationStore;
  private readonly collector: NativeIntegrityCollector;
  private readonly hintReader: ReinstallHintReader;
  private readonly stepUpKeyNative: NativeStepUpKey;

  private identityValue: InstallationIdentity | null = null;
  private session: string | null = null;

  // One call of each kind in flight; a second waits for the first's result.
  private loading: Promise<InstallationIdentity> | null = null;
  private starting: Promise<InstallationIdentity> | null = null;
  private proving: Promise<string> | null = null;
  private readonly scanning = new Map<string, Promise<ScanResult>>();

  // Which installation the calls running now belong to: reset() and close() move on to the next,
  // and a call of an earlier one keeps nothing it finds.
  private generation = 0;
  // A reset's deletion, which every later load waits for; and the installation ID being saved and a
  // re-enrolment, which a reset waits for.
  private resetting: Promise<void> | null = null;
  private saving: Promise<void> | null = null;
  private reenrolling: Promise<void> | null = null;
  // The persistent writes and key changes running now (mutate): a reset waits for each before it
  // deletes, so none outlives the deletion.
  private readonly mutations = new Set<Promise<void>>();
  private offeredStepUpKey: StepUpKeyMetadata | null = null;
  private hint: ReinstallHint | null = null;
  private hintRead = false;

  /** Why step-up is off on this phone although the app turned it on -- no screen lock, say -- or null. */
  stepUpUnavailable: NativeKeyException | null = null;

  /** Talks to your backend over JSON and HTTPS under [baseUrl], the SDK's default API (the public guide, section 4). */
  constructor(options: DeviceTrustOptions & { baseUrl: string });
  /** The same over the app's own [transport]. */
  constructor(options: DeviceTrustParts & { transport: DeviceTrustTransport });
  constructor(options: DeviceTrustParts & { baseUrl?: string; transport?: DeviceTrustTransport }) {
    const transport = options.transport ?? new HttpTransport(options.baseUrl ?? '');
    this.client = new DeviceTrustClient(transport, options.platform ? { platform: options.platform } : {});
    this.personalMeasurements = new Set(options.personalMeasurements ?? []);
    this.stepUp = options.stepUp ?? null;
    this.appPin = options.appPin ?? null;
    this.onRegistered = options.onRegistered ?? null;
    this.store = options.store ?? new InstallationStore();
    this.collector = options.collector ?? new NativeIntegrityCollector();
    this.hintReader = options.hintReader ?? new ReinstallHintReader();
    this.stepUpKeyNative = options.stepUpKey ?? new NativeStepUpKey();
  }

  /** The same over the app's own [transport]; [parts] replace the native ones in tests. */
  static over(transport: DeviceTrustTransport, parts: DeviceTrustParts = {}): DeviceTrust {
    return new DeviceTrust({ ...parts, transport });
  }

  get identity(): InstallationIdentity | null {
    return this.identityValue;
  }

  /** The installation session from proving the key, or null before [start]. */
  get installationSession(): string | null {
    return this.session;
  }

  /** The step-up key offered at the last registration. */
  get stepUpKey(): StepUpKeyMetadata | null {
    return this.offeredStepUpKey;
  }

  /** The wire names of [personalMeasurements], in the guide's order. */
  get enabledMeasurements(): string[] {
    return personalMeasurements.filter((measurement) => this.personalMeasurements.has(measurement));
  }

  /**
   * The installation: its key, made on first use, and its ID. A key made now is a new installation
   * ([InstallationIdentity.createdThisLaunch]): whatever the app kept for the one before belongs to
   * that one. Calls at once share one load, so one key gets one ID.
   */
  loadIdentity(): Promise<InstallationIdentity> {
    const known = this.identityValue;
    if (known !== null) {
      return Promise.resolve(known);
    }
    const running = this.loading;
    if (running !== null) {
      return running;
    }
    const loading: Promise<InstallationIdentity> = this.load().finally(() => {
      if (this.loading === loading) {
        this.loading = null;
      }
    });
    this.loading = loading;
    return loading;
  }

  private async load(): Promise<InstallationIdentity> {
    // A reset's deletion first, so that nothing loads the key it deletes.
    await this.resetting;
    const generation = this.generation;
    const loaded = await this.store.loadOrCreate();
    this.current(generation);
    if (this.identityValue === null) {
      this.identityValue = loaded;
    }
    return this.identityValue;
  }

  /**
   * A persistent write or a key change for the installation [generation]: refused before it starts
   * when reset() or close() has ended that installation, and waited for by a reset that began while
   * it ran. The order is the whole guarantee: endCalls() moves the generation on at once, in the
   * same turn as reset() is called, so a write asked for after that throws here without writing;
   * one asked for before is in [mutations], which the reset waits for before it deletes anything.
   */
  private mutate<T>(generation: number, change: () => Promise<T>): Promise<T> {
    this.current(generation);
    const running = change();
    const tracked = settled(running);
    this.mutations.add(tracked);
    void tracked.then(() => this.mutations.delete(tracked));
    return running;
  }

  /** Throws when reset() or close() ended the installation [generation] belongs to: a call keeps nothing of one that is gone. */
  private current(generation: number): void {
    if (generation !== this.generation) {
      throw new InterruptedCallException(
        'The installation was reset, or the client closed, while this call ran: nothing it found was kept.',
      );
    }
  }

  /**
   * Loads or makes the key, registers it -- with the step-up key, when step-up is on -- and proves
   * the installation holds it: the installation session. A refusal outside the guide's protocol
   * errors goes to the app as it came. A second call while one runs gets its result.
   */
  start(): Promise<InstallationIdentity> {
    const running = this.starting;
    if (running !== null) {
      return running;
    }
    const starting: Promise<InstallationIdentity> = this.startOnce().finally(() => {
      if (this.starting === starting) {
        this.starting = null;
      }
    });
    this.starting = starting;
    return starting;
  }

  private async startOnce(): Promise<InstallationIdentity> {
    const generation = this.generation;
    await this.loadIdentity();
    await this.register(generation);
    await this.prove();
    this.current(generation);
    return this.identityValue as InstallationIdentity;
  }

  /** A new installation session: the key's challenge, answered. A second call while one runs gets its result. */
  prove(): Promise<string> {
    const running = this.proving;
    if (running !== null) {
      return running;
    }
    const proving: Promise<string> = this.proveOnce(this.generation, false).finally(() => {
      if (this.proving === proving) {
        this.proving = null;
      }
    });
    this.proving = proving;
    return proving;
  }

  /**
   * Deletes the key, the installation ID (InstallationStore.clear) and the step-up key, and forgets
   * the session: the next start is a new installation, linked to this one by nothing it holds.
   * Calls still running end with InterruptedCallException and keep nothing; calls made from now on
   * wait for the deletion, and never join one made before.
   */
  reset(): Promise<void> {
    const loading = this.loading;
    const saving = this.saving;
    const reenrolling = this.reenrolling;
    const earlier = this.resetting;
    const changing = Array.from(this.mutations);
    this.endCalls();
    this.offeredStepUpKey = null;
    this.hint = null;
    this.hintRead = false;
    const deleting = (async () => {
      await earlier;
      // A load or a save still running finishes first, so that nothing it writes outlives the
      // deletion. So does a re-enrolment: its key, which a backend may already have taken, is
      // deleted after it, and the marker it writes is cleared. So does every write and key change
      // still running (mutate): the step-up marker, a step-up key being made.
      await Promise.all([
        ...(loading !== null ? [settled(loading)] : []),
        ...(saving !== null ? [settled(saving)] : []),
        ...(reenrolling !== null ? [reenrolling] : []),
        ...changing,
      ]);
      await this.store.clear();
      // The step-up key goes with the installation, as on a reinstall: kept, it would link the next
      // installation to this one. None to delete is no failure; nor is a phone or a build with no
      // step-up key at all. A key that stays is: reset() fails with it, the installation itself
      // gone, so the app knows and may call reset() again.
      try {
        await this.stepUpKeyNative.deleteKey();
      } catch (error) {
        if (!(error instanceof NativeKeyException)) {
          throw error;
        }
        if (error.code !== 'NATIVE_STEPUP_PLUGIN_MISSING' && error.code !== 'UNSUPPORTED_ANDROID_VERSION') {
          throw new NativeKeyException(
            error.code,
            `The installation was reset, but its step-up key could not be deleted: ${error.message} Call reset() again.`,
          );
        }
      }
    })();
    // Later loads wait for the deletion, whatever came of it; the caller of reset hears what did.
    this.resetting = settled(deleting);
    return deleting;
  }

  /** Moves on to the next installation: the calls running now keep nothing, and the next ones start afresh. */
  private endCalls(): void {
    this.generation++;
    this.identityValue = null;
    this.session = null;
    this.loading = null;
    this.starting = null;
    this.proving = null;
    this.scanning.clear();
  }

  private async proveOnce(generation: number, retried: boolean): Promise<string> {
    const identity = await this.loadIdentity();
    this.current(generation);
    try {
      const challenge = await this.client.createInstallationChallenge(identity.installationId);
      const payload = challenge['payload'] as string;
      const verified = await this.client.verifyInstallation({
        installationId: identity.installationId,
        challengeId: challenge['challenge_id'] as string,
        payload,
        signature: await identity.signPayload(payload),
      });
      this.current(generation);
      this.session = verified['device_token'] as string;
      return this.session;
    } catch (error) {
      if (!(error instanceof ApiException) || retried) {
        throw error;
      }
      switch (protocolStepFor(error, { deviceSession: true })) {
        case ProtocolStep.askAgain:
          break;
        case ProtocolStep.registerAgain:
          await this.register(generation);
          break;
        case ProtocolStep.waitThenRetry:
          await delay(protocolWait(error) as number);
          break;
        case ProtocolStep.proveAgain:
        case ProtocolStep.stop:
          throw error;
      }
      return this.proveOnce(generation, true);
    }
  }

  private async register(generation: number): Promise<void> {
    const identity = await this.loadIdentity();
    this.current(generation);
    if (!this.hintRead) {
      const hint = await this.hintReader.read();
      this.current(generation);
      this.hint = hint;
      this.hintRead = true;
    }
    const offered = await this.prepareStepUpKey(generation);
    const answer = await this.client.registerInstallation(identity, this.hint, { stepUpKey: offered });
    this.current(generation);
    // The key is the installation's identity: a backend that holds it under another ID answers with
    // that one, which is kept.
    const held = answer['installation_id'];
    if (typeof held === 'string' && held.length > 0 && held !== identity.installationId) {
      this.identityValue = identity.withInstallationId(held);
      const saving = this.store.saveInstallationId(held);
      this.saving = saving;
      await saving;
    }
    await this.settleStepUpKey(answer, offered, generation);
    await this.onRegistered?.(answer);
  }

  /**
   * Whether the backend holds the step-up key offered: it takes one only when it first registers an
   * installation, so a key made later -- after the screen lock was removed and set again, say -- it
   * takes by re-enrolment alone. Its answer says so (`stepup_key_matches`, or for an installation
   * new to it `stepup_key_registered`); until it holds this key, approvals wait for reenrolStepUp,
   * across restarts too. A registration without a key, the phone unable to make one, leaves any key
   * made later waiting the same way. A backend whose answer says nothing is taken at its word unless
   * a re-enrolment is pending.
   */
  private async settleStepUpKey(answer: JsonObject, offered: StepUpKeyMetadata | null, generation: number): Promise<void> {
    if (this.stepUp === null) {
      return;
    }
    const matches = answer['stepup_key_matches'];
    const registered = answer['stepup_key_registered'];
    const bound: boolean | null =
      offered === null
        ? null
        : typeof matches === 'boolean'
          ? matches
          : typeof registered === 'boolean'
            ? registered
            : null;
    if (offered === null || bound === false) {
      await this.mutate(generation, () => this.store.setStepUpReenrolPending(true));
    } else if (bound === true) {
      await this.mutate(generation, () => this.store.setStepUpReenrolPending(false));
    }
    const pending = offered !== null && bound !== true && (await this.store.stepUpReenrolPending());
    this.current(generation);
    if (pending) {
      this.offeredStepUpKey = null;
      this.stepUpUnavailable = DeviceTrust.reenrolPending();
    }
  }

  /**
   * The step-up key as [stepUp] asks: an existing key is kept as it is. Step-up is optional, so a
   * key the phone cannot make leaves it off. Its use waits for the backend's answer
   * (settleStepUpKey).
   */
  private async prepareStepUpKey(generation: number): Promise<StepUpKeyMetadata | null> {
    const options = this.stepUp;
    if (options === null) {
      this.stepUpUnavailable = null;
      this.offeredStepUpKey = null;
      return null;
    }
    this.stepUpKeyNative.configuredMode = options.mode;
    let key: StepUpKeyMetadata | null = null;
    let unavailable: NativeKeyException | null = null;
    try {
      key = await this.mutate(generation, () =>
        this.stepUpKeyNative.getOrCreateKey({
          factor: options.factor,
          mode: options.mode,
          windowSeconds: options.windowSeconds,
        }),
      );
    } catch (error) {
      if (!(error instanceof NativeKeyException)) {
        throw error;
      }
      unavailable = error;
    }
    this.current(generation);
    this.stepUpUnavailable = unavailable;
    this.offeredStepUpKey = key;
    return key;
  }

  /** A step-up key a re-enrolment replaces: one that can never sign again, or one the keystore cannot vouch for. */
  private static replaceableKey(error: NativeKeyException): boolean {
    return error.code === 'STEPUP_KEY_INVALIDATED' || error.code === 'STEPUP_KEY_UNAVAILABLE';
  }

  /** What approvals answer while the backend does not hold the step-up key. */
  private static reenrolPending(): NativeKeyException {
    return new NativeKeyException(
      'STEPUP_REENROL_PENDING',
      'The backend does not hold this step-up key -- a re-enrolment unfinished, or a key made after the ' +
        'installation was registered: reenrolStepUp() first.',
    );
  }

  /**
   * A scan: under the installation session -- or, for a scan that approves one [operation]
   * ([describeOperation]), under the app's account [session] for this installation, the one that
   * will send that request. The guide's protocol errors are acted on once; an account session is
   * the app's to renew. A second call for the same scan while one runs gets its result; a scan
   * whose answer was lost is simply asked for again.
   */
  scan(options: { session?: string | null; operation?: Record<string, unknown> | null } = {}): Promise<ScanResult> {
    const session = options.session ?? null;
    const operation = options.operation ?? null;
    if (operation !== null && session === null) {
      throw new TypeError('session: a scan for one operation is asked under the account session that will send it');
    }
    // The personal measurements enabled now are part of the scan: one asked for after the person
    // changed them never joins one asked for before.
    const enabled = this.enabledMeasurements;
    const kind = JSON.stringify([session, operation, enabled]);
    const running = this.scanning.get(kind);
    if (running !== undefined) {
      return running;
    }
    const scanning: Promise<ScanResult> = this.scanWithProtocol(this.generation, session, operation, enabled).finally(() => {
      if (this.scanning.get(kind) === scanning) {
        this.scanning.delete(kind);
      }
    });
    this.scanning.set(kind, scanning);
    return scanning;
  }

  private async scanWithProtocol(
    generation: number,
    session: string | null,
    operation: Record<string, unknown> | null,
    enabled: string[],
  ): Promise<ScanResult> {
    try {
      return await this.scanOnce(generation, session, operation, enabled);
    } catch (error) {
      if (!(error instanceof ApiException)) {
        throw error;
      }
      const installationSession = session === null;
      switch (protocolStepFor(error, { deviceSession: installationSession })) {
        case ProtocolStep.askAgain:
          break;
        case ProtocolStep.proveAgain:
          await this.prove();
          break;
        case ProtocolStep.registerAgain:
          // An account session belongs to the installation the backend lost: the app signs in again.
          if (!installationSession) {
            throw error;
          }
          await this.register(generation);
          await this.prove();
          break;
        case ProtocolStep.waitThenRetry:
          await delay(protocolWait(error) as number);
          break;
        case ProtocolStep.stop:
          throw error;
      }
      return this.scanOnce(generation, session, operation, enabled);
    }
  }

  private async scanOnce(
    generation: number,
    session: string | null,
    operation: Record<string, unknown> | null,
    enabled: string[],
  ): Promise<ScanResult> {
    const identity = await this.loadIdentity();
    const bearer = session ?? this.session ?? (await this.prove());
    this.current(generation);
    const challenge = await this.client.integrityChallenge({ session: bearer, identity, operation });
    const report = await collectReport({
      challenge,
      identity,
      collector: this.collector,
      enabledMeasurements: enabled,
    });
    // A report of an installation reset meanwhile is never sent.
    this.current(generation);
    const answer = await this.client.submitIntegrityReport({ session: bearer, identity, report });
    this.current(generation);
    return new ScanResult({ challenge, report, answer });
  }

  /**
   * Signs one request to your backend under [bearer], your account session: [body] is sent exactly
   * as given. With [stepUp] the person approves it with the step-up key -- the phone asks, saying
   * [reason]; with [appPin] the backend checks the PIN for it first; [reportId] names the scan made
   * for it alone. Send it with RequestProof.headers beside `Authorization: Bearer`, or with [send];
   * each proof serves this request once.
   */
  async signRequest(args: {
    method: string;
    path: string;
    bearer: string;
    body?: string;
    stepUp?: boolean;
    reason?: string;
    appPin?: string | null;
    reportId?: string | null;
  }): Promise<RequestProof> {
    const generation = this.generation;
    const identity = await this.loadIdentity();
    this.current(generation);
    let approval: StepUpApproval | null = null;
    if (args.stepUp === true) {
      // Only the key the backend received at registration: a key made later would sign approvals
      // the backend cannot check.
      const key = this.offeredStepUpKey;
      if (key === null) {
        throw (
          this.stepUpUnavailable ??
          new NativeKeyException(
            'STEPUP_OFF',
            this.stepUp === null
              ? 'Step-up is off: new DeviceTrust({ stepUp: new StepUpOptions(), ... }).'
              : 'No step-up key was registered: start() first.',
          )
        );
      }
      const reason = args.reason ?? 'Approve this request';
      approval = {
        factor: key.factor,
        sign: (payload: string) => this.stepUpKeyNative.sign(payload, { reason }),
      };
    }
    let proof = await signRequestProof({
      identity,
      method: args.method,
      path: args.path,
      bearerToken: args.bearer,
      encodedBody: args.body ?? '',
      stepUp: approval,
    });
    // The installation reset, or the client closed, while the phone signed: the proof is of an
    // installation that is gone, and is never handed out.
    this.current(generation);
    if (args.appPin != null) {
      const options = this.appPin;
      if (options === null) {
        throw new Error('The app PIN is off: new DeviceTrust({ appPin: new AppPinOptions(), ... }).');
      }
      proof = await this.client.proveAppPin({
        session: args.bearer,
        identity,
        pin: args.appPin,
        request: proof,
        path: options.proofPath,
      });
      this.current(generation);
    }
    return args.reportId == null ? proof : proof.withIntegrityReport(args.reportId);
  }

  /**
   * Re-enrols the step-up key under the account [session], with the person's own
   * [reauthentication] -- the account's password, say: `{password: ...}`. For a key the phone has
   * lost or can no longer use -- the screen lock removed (`STEPUP_KEY_INVALIDATED`) -- or one made
   * for other options: the person unlocks the new key to sign its proof, the phone showing
   * [reason], and the backend takes it for that account alone (the public guide, section 3).
   * Approvals use it from then on. A key replaced before the backend took the new one -- the person
   * cancelled, the password was wrong, the answer was lost -- leaves step-up waiting: approvals
   * answer `STEPUP_REENROL_PENDING`, across restarts too, until a call of this succeeds.
   */
  reenrolStepUp(args: { session: string; reauthentication?: Record<string, unknown>; reason?: string }): Promise<JsonObject> {
    const running = this.reenrolStepUpOnce(
      args.session,
      args.reauthentication ?? {},
      args.reason ?? 'Confirm your new step-up key',
    );
    // reset() waits for it, whatever comes of it.
    this.reenrolling = settled(running);
    return running;
  }

  private async reenrolStepUpOnce(
    session: string,
    reauthentication: Record<string, unknown>,
    reason: string,
  ): Promise<JsonObject> {
    const options = this.stepUp;
    if (options === null) {
      throw new NativeKeyException('STEPUP_OFF', 'Step-up is off: new DeviceTrust({ stepUp: new StepUpOptions(), ... }).');
    }
    const generation = this.generation;
    const identity = await this.loadIdentity();
    this.current(generation);
    this.stepUpKeyNative.configuredMode = options.mode;
    const newKey = async (replace: boolean): Promise<StepUpKeyMetadata> => {
      if (replace) {
        // From here the phone's key and the backend's differ until the backend takes the new one:
        // approvals wait for that.
        await this.mutate(generation, () => this.store.setStepUpReenrolPending(true));
        this.current(generation);
        this.offeredStepUpKey = null;
        this.stepUpUnavailable = DeviceTrust.reenrolPending();
        await this.mutate(generation, () => this.stepUpKeyNative.deleteKey());
      }
      return this.mutate(generation, () =>
        this.stepUpKeyNative.getOrCreateKey({
          factor: options.factor,
          mode: options.mode,
          windowSeconds: options.windowSeconds,
        }),
      );
    };

    // A re-enrolment is the explicit recovery: a key the keystore cannot vouch for
    // (STEPUP_KEY_UNAVAILABLE), or one that can never sign again, is replaced here -- and only here.
    let key: StepUpKeyMetadata;
    try {
      key = await newKey(false);
    } catch (error) {
      if (!(error instanceof NativeKeyException) || !DeviceTrust.replaceableKey(error)) {
        throw error;
      }
      key = await newKey(true);
    }
    if (!key.created && !options.accepts(key)) {
      key = await newKey(true);
    }
    // The new key signs a proof bound to this request's own nonce, which the request proof then
    // signs too.
    const nonce = await freshNonce();
    const proveWith = async (current: StepUpKeyMetadata): Promise<Record<string, string>> => {
      const payload = stepUpReenrolProof({
        installationId: identity.installationId,
        stepUpKeyThumbprint: current.thumbprint,
        nonce: base64UrlNoPadding(nonce),
        timestamp: nowSeconds(),
      });
      return {
        stepup_key_proof: payload,
        stepup_key_signature: await this.stepUpKeyNative.sign(payload, { reason }),
      };
    };

    let keyProof: Record<string, string>;
    try {
      keyProof = await proveWith(key);
    } catch (error) {
      // A key that died with the screen lock is found only when it signs.
      if (
        !(error instanceof NativeKeyException) ||
        (!DeviceTrust.replaceableKey(error) && error.code !== 'STEPUP_KEY_NOT_FOUND')
      ) {
        throw error;
      }
      key = await newKey(true);
      keyProof = await proveWith(key);
    }
    const proof = await signRequestProof({
      identity,
      method: 'POST',
      path: options.reenrolPath,
      bearerToken: session,
      encodedBody: JSON.stringify({
        ...reauthentication,
        stepup_public_key: key.publicKey,
        stepup_key_auth: key.authJson,
        ...keyProof,
      }),
      nonce,
    });
    const answer = await this.send(proof);
    await this.mutate(generation, () => this.store.setStepUpReenrolPending(false));
    this.current(generation);
    this.offeredStepUpKey = key;
    this.stepUpUnavailable = null;
    return answer;
  }

  /** Sends [proof]'s request through the SDK's transport. */
  send(proof: RequestProof): Promise<JsonObject> {
    return this.client.sendSigned(proof);
  }

  /**
   * Sets the account's app PIN under the account [session], with the person's own
   * [reauthentication] -- the account's password, say: `{password: ...}`.
   */
  async setAppPin(args: { session: string; pin: string; reauthentication?: Record<string, unknown> }): Promise<JsonObject> {
    const options = this.appPin;
    if (options === null) {
      throw new Error('The app PIN is off: new DeviceTrust({ appPin: new AppPinOptions(), ... }).');
    }
    const generation = this.generation;
    const identity = await this.loadIdentity();
    this.current(generation);
    const answer = await this.client.setAppPin({
      session: args.session,
      identity,
      pin: args.pin,
      reauthentication: args.reauthentication ?? {},
      path: options.path,
    });
    this.current(generation);
    return answer;
  }

  /**
   * Asks the person for the location permission, for the location measurements: from a button on
   * the app's own screen, since a scan never asks. Answers `precise`, `approximate` or `none`.
   */
  requestLocationPermission(): Promise<string> {
    return this.collector.requestLocationPermission();
  }

  /**
   * Closes the transport. Calls still running end with InterruptedCallException, or with the
   * transport's own failure, and keep nothing; the key and the installation stay as they are.
   */
  close(): void {
    this.endCalls();
    this.client.close();
  }
}
