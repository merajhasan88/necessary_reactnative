// The installation across a phone's life: the first start, a restart, a key the platform lost (an
// Android reinstall), and an iOS reinstall that kept the key but not the app's other data -- two of
// the SDK's calls at once, and a reset or a close while calls still run.
import {
  DeviceTrust,
  describeOperation,
  InstallationIdentity,
  InstallationStore,
  InterruptedCallException,
  NativeInstallationKey,
  NativeIntegrityCollector,
  NativeKeyException,
  NativeKeyMetadata,
  NativeStepUpKey,
  PersonalMeasurement,
  ReinstallHintReader,
  StepUpKeyMetadata,
  StepUpOptions,
  type DeviceTrustTransport,
  type JsonObject,
  type ReinstallHint,
  type ScanResult,
  type SecureStorage,
  type SendOptions,
} from '../src';
import { completer, delay, expectNativeCode } from './support/fakes';

const STORED = 'recognition.installation_id.v2';

/** The phone's secure storage, in memory: a test sets what it holds at the start. */
class MemoryStorage implements SecureStorage {
  readonly values: Map<string, string>;
  constructor(initial: Record<string, string> = {}) {
    this.values = new Map(Object.entries(initial));
  }
  async read(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async write(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
});
const storedId = (): Promise<string | null> => storage.read(STORED);
const storeOf = (key: NativeInstallationKey): InstallationStore => new InstallationStore({ key, storage });

/** A platform keystore holding, or not holding, the installation key. */
class Keystore extends NativeInstallationKey {
  holds: boolean;
  constructor(holds: boolean) {
    super();
    this.holds = holds;
  }
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    const created = !this.holds;
    this.holds = true;
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
  override async signPayload(): Promise<string> {
    return 'signed';
  }
  override async deleteKey(): Promise<void> {
    this.holds = false;
  }
}

/** A keystore that holds the key but cannot be reached at first: the SDK's Android side then answers KEY_UNAVAILABLE and makes no key. */
class UnreachableKeystore extends Keystore {
  reachable = false;
  constructor() {
    super(true);
  }
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    if (!this.reachable) {
      throw new NativeKeyException(
        'KEY_UNAVAILABLE',
        'AndroidKeyStore could not be reached for the installation key; the key was kept, never replaced.',
      );
    }
    return super.getOrCreateKey();
  }
}

/** Answers as the guide says; counts what it was asked. */
class Backend implements DeviceTrustTransport {
  readonly paths: string[] = [];
  async send(_method: string, path: string, _options: SendOptions = {}): Promise<JsonObject> {
    this.paths.push(path);
    await delay(0);
    switch (path) {
      case '/v1/installations/register':
        return { installation_id: 'held' };
      case '/v1/installations/challenge':
        return { challenge_id: 'k', payload: 'cA' };
      case '/v1/installations/verify':
        return { device_token: 'session' };
      case '/v1/integrity/challenge':
        return { challenge_id: 's', nonce: 'bg', platform: 'android', required_probes: ['app_identity'] };
      default:
        return { integrity: { report_id: 'r' } };
    }
  }
  close(): void {}
}

class Collector extends NativeIntegrityCollector {
  override async collect(args: { requiredProbes: string[]; challengeNonce: string; enabledMeasurements: string[] }): Promise<
    Record<string, unknown>
  > {
    return {
      platform: 'android',
      challenge_nonce_echo: args.challengeNonce,
      collector_version: 8,
      probes: { app_identity: { status: 'ok' } },
    };
  }
}

class NoHint extends ReinstallHintReader {
  override async read(): Promise<ReinstallHint | null> {
    return null;
  }
}

/**
 * Answers as [Backend] does, but with a new installation ID and a new session each time, in the
 * order answered; and holds the answer to a path while a test says so.
 */
class HeldBackend extends Backend {
  private readonly held = new Map<string, Promise<void>>();
  private readonly askedFor = new Map<string, { promise: Promise<void>; complete: (value: void) => void }>();
  private registered = 0;
  private proved = 0;

  /** The next request to [path] waits until the returned function is called. */
  hold(path: string): () => void {
    const gate = completer();
    this.held.set(path, gate.promise);
    return () => gate.complete();
  }

  /** Resolves once [path] has been asked. */
  asked(path: string): Promise<void> {
    if (!this.askedFor.has(path)) this.askedFor.set(path, completer());
    return this.askedFor.get(path)!.promise;
  }

  override async send(method: string, path: string, options: SendOptions = {}): Promise<JsonObject> {
    if (!this.askedFor.has(path)) this.askedFor.set(path, completer());
    this.askedFor.get(path)!.complete();
    const held = this.held.get(path);
    if (held !== undefined) {
      this.held.delete(path);
      await held;
    }
    const answer = await super.send(method, path, options);
    switch (path) {
      case '/v1/installations/register':
        return { installation_id: `held-${++this.registered}` };
      case '/v1/installations/verify':
        return { device_token: `session-${++this.proved}` };
      default:
        return answer;
    }
  }
}

/** A collector that waits, at its first collection, until the test lets it go on; and notes what each collection was allowed to measure. */
class HeldCollector extends Collector {
  readonly reached = completer();
  readonly goOn = completer();
  private reachedOnce = false;
  readonly enabled: string[][] = [];
  override async collect(args: { requiredProbes: string[]; challengeNonce: string; enabledMeasurements: string[] }): Promise<
    Record<string, unknown>
  > {
    this.enabled.push(args.enabledMeasurements);
    if (!this.reachedOnce) {
      this.reachedOnce = true;
      this.reached.complete();
    }
    await this.goOn.promise;
    return super.collect(args);
  }
}

/** A store that counts its loads, each taking a moment. */
class CountingStore extends InstallationStore {
  loads = 0;
  constructor() {
    super({ key: new Keystore(false), storage });
  }
  override async loadOrCreate(): Promise<InstallationIdentity> {
    this.loads++;
    await delay(5);
    return super.loadOrCreate();
  }
}

/** A keystore whose signatures wait, once [hold] is set, until [goOn]. */
class HeldSigningKeystore extends Keystore {
  hold = false;
  readonly reached = completer();
  readonly goOn = completer();
  constructor() {
    super(false);
  }
  override async signPayload(): Promise<string> {
    if (this.hold) {
      this.reached.complete();
      await this.goOn.promise;
    }
    return super.signPayload();
  }
}

/** A store whose first step-up marker write waits until [goOn]. */
class HeldMarkerStore extends InstallationStore {
  readonly reached = completer();
  readonly goOn = completer();
  private reachedOnce = false;
  constructor() {
    super({ key: new Keystore(false), storage });
  }
  override async setStepUpReenrolPending(pending: boolean): Promise<void> {
    if (!this.reachedOnce) {
      this.reachedOnce = true;
      this.reached.complete();
      await this.goOn.promise;
    }
    return super.setStepUpReenrolPending(pending);
  }
}

/** A phone that makes no step-up key; or, given [deleteFails], one whose key the keystore will not delete. */
class StepUpKeystore extends NativeStepUpKey {
  readonly makes: boolean;
  readonly deleteFails: string | null;
  constructor(options: { makes?: boolean; deleteFails?: string } = {}) {
    super();
    this.makes = options.makes ?? false;
    this.deleteFails = options.deleteFails ?? null;
  }
  override async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    if (!this.makes) {
      throw new NativeKeyException('STEPUP_UNAVAILABLE', 'no screen lock');
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
  override async deleteKey(): Promise<void> {
    if (this.deleteFails !== null) {
      throw new NativeKeyException(this.deleteFails, 'the keystore refused');
    }
  }
}

const interrupted = (promise: Promise<unknown>): Promise<void> => expect(promise).rejects.toBeInstanceOf(InterruptedCallException);

const over = (backend: DeviceTrustTransport, parts: Partial<Parameters<typeof DeviceTrust.over>[1]> = {}): DeviceTrust =>
  DeviceTrust.over(backend, { collector: new Collector(), hintReader: new NoHint(), ...parts });

test('the first start makes the key and an installation ID; a restart finds both', async () => {
  const keystore = new Keystore(false);
  const first = await storeOf(keystore).loadOrCreate();
  expect(first.createdThisLaunch).toBe(true);
  expect(await storedId()).toBe(first.installationId);
  const restarted = await storeOf(keystore).loadOrCreate();
  expect(restarted.createdThisLaunch).toBe(false);
  expect(restarted.installationId).toBe(first.installationId);
});

test('a key the platform lost is a new installation, under a new ID', async () => {
  storage = new MemoryStorage({ [STORED]: 'old-installation' });
  const identity = await storeOf(new Keystore(false)).loadOrCreate();
  expect(identity.createdThisLaunch).toBe(true);
  expect(identity.installationId).not.toBe('old-installation');
  expect(await storedId()).toBe(identity.installationId);
});

test('a key kept without its ID proposes a new one, and keeps the one the backend holds for the key', async () => {
  const store = storeOf(new Keystore(true));
  const proposed = await store.loadOrCreate();
  expect(proposed.createdThisLaunch).toBe(false);
  const trust = over(new Backend(), { store });
  await trust.start();
  expect(trust.identity?.installationId).toBe('held');
  expect(await storedId()).toBe('held');
});

test('a keystore that cannot be reached leaves the installation as it was: start() fails with KEY_UNAVAILABLE and sends nothing, and the ID is kept for the key once the keystore answers', async () => {
  storage = new MemoryStorage({ [STORED]: 'kept-installation' });
  const keystore = new UnreachableKeystore();
  const backend = new Backend();
  const trust = over(backend, { store: storeOf(keystore) });
  await expectNativeCode(trust.start(), 'KEY_UNAVAILABLE');
  expect(backend.paths).toEqual([]);
  expect(await storedId()).toBe('kept-installation');
  expect(keystore.holds).toBe(true);
  keystore.reachable = true;
  const again = await storeOf(keystore).loadOrCreate();
  expect(again.createdThisLaunch).toBe(false);
  expect(again.installationId).toBe('kept-installation');
});

test('reset deletes the key and the ID: the next start is a new installation', async () => {
  const keystore = new Keystore(false);
  const trust = over(new Backend(), { store: storeOf(keystore) });
  await trust.start();
  await trust.reset();
  expect(keystore.holds).toBe(false);
  expect(await storedId()).toBeNull();
  expect(trust.identity).toBeNull();
  expect(trust.installationSession).toBeNull();
  expect((await trust.loadIdentity()).createdThisLaunch).toBe(true);
});

test('two calls of one kind at once share one run; other scans run apart', async () => {
  const backend = new Backend();
  const trust = over(backend, { store: storeOf(new Keystore(false)) });
  const started = await Promise.all([trust.start(), trust.start()]);
  expect(started[0]).toBe(started[1]);
  expect(backend.paths.filter((path) => path === '/v1/installations/register')).toHaveLength(1);
  expect(backend.paths.filter((path) => path === '/v1/installations/verify')).toHaveLength(1);

  backend.paths.length = 0;
  const pay = describeOperation('POST', '/v1/pay', '{}');
  const payee = describeOperation('POST', '/v1/payee', '{}');
  const scans = await Promise.all([
    trust.scan(),
    trust.scan(),
    trust.scan({ session: 'account', operation: pay }),
    trust.scan({ session: 'account', operation: payee }),
  ]);
  expect(scans[0]).toBe(scans[1]);
  expect(backend.paths.filter((path) => path === '/v1/integrity/challenge')).toHaveLength(3);
  expect(backend.paths.filter((path) => path === '/v1/integrity/report')).toHaveLength(3);
});

test("a reset while start() waits for its key challenge's answer: the old answer is kept nowhere, and a new start() never joins the old one", async () => {
  const backend = new HeldBackend();
  const trust = over(backend, { store: storeOf(new Keystore(false)) });
  const verify = backend.hold('/v1/installations/verify');
  const old = interrupted(trust.start());
  await backend.asked('/v1/installations/verify');
  await trust.reset();
  const fresh = await trust.start();
  expect(trust.installationSession).toBe('session-1');
  verify();
  await old;
  expect(trust.installationSession).toBe('session-1');
  expect(trust.identity?.installationId).toBe(fresh.installationId);
  expect(await storedId()).toBe(fresh.installationId);
});

test('a reset while start() waits for its registration: the ID the old answer names is never kept', async () => {
  const backend = new HeldBackend();
  const trust = over(backend, { store: storeOf(new Keystore(false)) });
  const register = backend.hold('/v1/installations/register');
  const old = interrupted(trust.start());
  await backend.asked('/v1/installations/register');
  await trust.reset();
  const fresh = await trust.start();
  expect(fresh.installationId).toBe('held-1');
  register();
  await old;
  expect(trust.identity?.installationId).toBe('held-1');
  expect(await storedId()).toBe('held-1');
});

test('a reset while the old registration writes the step-up marker: the reset waits for the write, and the marker never outlives it', async () => {
  const store = new HeldMarkerStore();
  const trust = over(new Backend(), { store, stepUp: new StepUpOptions(), stepUpKey: new StepUpKeystore() });
  const old = interrupted(trust.start());
  await store.reached.promise;
  let reset = false;
  const resetting = trust.reset().then(() => (reset = true));
  await delay(10);
  expect(reset).toBe(false); // the reset waits for the write in flight
  store.goOn.complete();
  await resetting;
  await old;
  expect(await store.stepUpReenrolPending()).toBe(false);
});

test('a reset while a request is signed: the proof is never handed out', async () => {
  const key = new HeldSigningKeystore();
  const trust = over(new Backend(), { store: storeOf(key) });
  await trust.start();
  key.hold = true;
  const signing = interrupted(trust.signRequest({ method: 'POST', path: '/v1/pay', bearer: 'session' }));
  await key.reached.promise;
  await trust.reset();
  key.goOn.complete();
  await signing;
});

test('a step-up key the keystore will not delete fails the reset, the installation gone all the same; none to delete fails nothing', async () => {
  const trust = over(new Backend(), {
    store: storeOf(new Keystore(false)),
    stepUp: new StepUpOptions(),
    stepUpKey: new StepUpKeystore({ makes: true, deleteFails: 'KEY_DELETE_FAILED' }),
  });
  await trust.start();
  await expectNativeCode(trust.reset(), 'KEY_DELETE_FAILED');
  expect(trust.identity).toBeNull();
  expect(await storedId()).toBeNull();
  const plain = over(new Backend(), {
    store: storeOf(new Keystore(false)),
    stepUp: new StepUpOptions(),
    stepUpKey: new StepUpKeystore({ deleteFails: 'NATIVE_STEPUP_PLUGIN_MISSING' }),
  });
  await plain.start();
  await plain.reset();
});

test('a reset while a scan collects: its report is never sent', async () => {
  const backend = new Backend();
  const collector = new HeldCollector();
  const trust = over(backend, { store: storeOf(new Keystore(false)), collector });
  await trust.start();
  const scan = interrupted(trust.scan());
  await collector.reached.promise;
  await trust.reset();
  collector.goOn.complete();
  await scan;
  expect(backend.paths).not.toContain('/v1/integrity/report');
});

test('close() while start() runs: the call keeps nothing', async () => {
  const backend = new HeldBackend();
  const trust = over(backend, { store: storeOf(new Keystore(false)) });
  const verify = backend.hold('/v1/installations/verify');
  const started = interrupted(trust.start());
  await backend.asked('/v1/installations/verify');
  trust.close();
  verify();
  await started;
  expect(trust.installationSession).toBeNull();
});

test('the store itself, asked twice at once, makes one ID for one key', async () => {
  const store = storeOf(new Keystore(false));
  const loaded = await Promise.all([store.loadOrCreate(), store.loadOrCreate()]);
  expect(loaded[0].installationId).toBe(loaded[1].installationId);
  expect(await storedId()).toBe(loaded[0].installationId);
});

test('two first loads at once load once: one key, one installation ID', async () => {
  const store = new CountingStore();
  const trust = over(new Backend(), { store });
  const loaded = await Promise.all([trust.loadIdentity(), trust.loadIdentity()]);
  expect(loaded[0]).toBe(loaded[1]);
  expect(store.loads).toBe(1);
  expect(await storedId()).toBe(loaded[0].installationId);
});

test('a scan asked after the personal measurements changed never joins one asked before', async () => {
  const backend = new Backend();
  const collector = new HeldCollector();
  const trust = over(backend, { store: storeOf(new Keystore(false)), collector });
  await trust.start();
  const before = trust.scan();
  await collector.reached.promise;
  trust.personalMeasurements = new Set([PersonalMeasurement.location]);
  const after = trust.scan();
  expect(before).not.toBe(after);
  collector.goOn.complete();
  const scans: ScanResult[] = await Promise.all([before, after]);
  expect(collector.enabled).toEqual([[], ['location']]);
  expect(scans[1].report.report['enabled_measurements']).toEqual(['location']);
});
