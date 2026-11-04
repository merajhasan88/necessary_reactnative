// The SDK end to end against a sample backend (backend/), over real HTTP with real P-256
// signatures: only the phone's keystore and collector are replaced, by a software key and the
// contract's Android samples -- the complete one unless a test says otherwise.
//
// Runs when NECESSARY_BACKEND_URL names a backend; skipped otherwise. The tests that need the
// backend's test controls need NECESSARY_TEST_TOKEN, the token they answer (backend/run_e2e.sh does
// both); without the token they are skipped, as for a deployed sample.
import { generateKeyPairSync, randomInt, sign as signBytes, type KeyObject } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ApiException,
  AppPinOptions,
  base64UrlNoPadding,
  DeviceTrust,
  describeOperation,
  HttpTransport,
  InstallationIdentity,
  InstallationStore,
  NativeInstallationKey,
  NativeIntegrityCollector,
  NativeKeyException,
  NativeKeyMetadata,
  NativeStepUpKey,
  personalMeasurements,
  randomUuid,
  ReinstallHint,
  ReinstallHintReader,
  signRequest,
  StepUpKeyMetadata,
  StepUpOptions,
  type JsonObject,
  type RequestProof,
} from '../src';
import { base64UrlDecode, utf8Encode } from '../src/util/bytes';
import { expectNativeCode } from './support/fakes';
import { readJson, repositoryDirectory } from './support/repositoryFiles';

const backend = process.env['NECESSARY_BACKEND_URL'];
const testToken = process.env['NECESSARY_TEST_TOKEN'];
const SAMPLES = 'contract/report-1/android-8-ios-5/samples';

jest.setTimeout(60000);

/** A P-256 key in software: signs as the phone's keystore does, ECDSA over SHA-256 with an ASN.1 DER signature. */
class SoftwareKey {
  private readonly privateKey: KeyObject;
  readonly jwk: Record<string, unknown>;
  constructor() {
    const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    this.privateKey = pair.privateKey;
    const exported = pair.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    this.jwk = { kty: 'EC', crv: 'P-256', alg: 'ES256', x: exported['x'], y: exported['y'] };
  }
  sign(payloadBase64Url: string): string {
    const signature = signBytes('sha256', base64UrlDecode(payloadBase64Url), { key: this.privateKey, dsaEncoding: 'der' });
    return base64UrlNoPadding(Uint8Array.from(signature));
  }
}

class SoftwareInstallationKey extends NativeInstallationKey {
  readonly key = new SoftwareKey();
  made = false;
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    const created = !this.made;
    this.made = true;
    return new NativeKeyMetadata({
      publicKey: this.key.jwk,
      algorithm: 'ES256',
      keyAlias: 'software',
      provider: 'AndroidKeyStore',
      securityLevel: 'software',
      hardwareBacked: false,
      privateKeyExportable: false,
      signatureFormat: 'der',
      created,
    });
  }
  override async signPayload(payloadBase64Url: string): Promise<string> {
    return this.key.sign(payloadBase64Url);
  }
  override async deleteKey(): Promise<void> {
    this.made = false;
  }
}

/** The installation ID in memory, beside the software key. */
class MemoryStore extends InstallationStore {
  stored: string | null = null;
  reenrolPending = false;
  constructor() {
    super({ key: new SoftwareInstallationKey() });
  }
  override async loadOrCreate(): Promise<InstallationIdentity> {
    const metadata = await this.key.getOrCreateKey();
    if (this.stored === null || metadata.created) {
      this.stored = await randomUuid();
    }
    return new InstallationIdentity({ installationId: this.stored, nativeKey: this.key, metadata });
  }
  override async saveInstallationId(installationId: string): Promise<void> {
    this.stored = installationId;
  }
  override async stepUpReenrolPending(): Promise<boolean> {
    return this.reenrolPending;
  }
  override async setStepUpReenrolPending(pending: boolean): Promise<void> {
    this.reenrolPending = pending;
  }
}

class SoftwareStepUpKey extends NativeStepUpKey {
  key = new SoftwareKey();
  /** The screen lock removed: the key can no longer sign. */
  dead = false;
  /** Whether the phone has a screen lock: without one no key is made. */
  locked = true;
  override async getOrCreateKey(args: { factor: string; mode: string; windowSeconds: number }): Promise<StepUpKeyMetadata> {
    if (!this.locked) {
      throw new NativeKeyException('STEPUP_NO_DEVICE_CREDENTIAL', 'no lock');
    }
    return new StepUpKeyMetadata({
      publicKey: this.key.jwk,
      factor: args.factor,
      mode: args.mode,
      windowSeconds: args.windowSeconds,
      securityLevel: 'software',
      hardwareBacked: false,
      created: false,
    });
  }
  override async sign(payload: string): Promise<string> {
    if (this.dead) {
      throw new NativeKeyException('STEPUP_KEY_INVALIDATED', 'the lock was removed');
    }
    return this.key.sign(payload);
  }
  override async deleteKey(): Promise<void> {
    this.key = new SoftwareKey();
    this.dead = false;
  }
}

/** One of the contract's sample reports, with its plan and how it is judged. */
const sample = (name: string): Record<string, any> => readJson(`${SAMPLES}/${name}.json`);

/** Answers with one of the contract's Android samples, whatever is asked. */
class SampleCollector extends NativeIntegrityCollector {
  private readonly probes: Record<string, unknown>;
  constructor(
    name = 'android-8-complete',
    private readonly collectorVersion = 8,
  ) {
    super();
    this.probes = sample(name)['report']['probe_results'];
  }
  override async collect(args: { challengeNonce: string }): Promise<Record<string, unknown>> {
    return { platform: 'android', challenge_nonce_echo: args.challengeNonce, collector_version: this.collectorVersion, probes: this.probes };
  }
}

class Hint extends ReinstallHintReader {
  override async read(): Promise<ReinstallHint | null> {
    return new ReinstallHint({
      kind: 'android_id_sha256',
      value: Array.from({ length: 64 }, () => '0123456789abcdef'[randomInt(16)]).join(''),
    });
  }
}

function trust(options: { stepUp?: StepUpOptions; appPin?: AppPinOptions; stepUpKey?: SoftwareStepUpKey; collector?: SampleCollector } = {}): DeviceTrust {
  return DeviceTrust.over(new HttpTransport(backend as string), {
    stepUp: options.stepUp ?? null,
    appPin: options.appPin ?? null,
    store: new MemoryStore(),
    collector: options.collector ?? new SampleCollector(),
    hintReader: new Hint(),
    stepUpKey: options.stepUpKey ?? new SoftwareStepUpKey(),
    platform: () => 'android',
  });
}

/** A test control, and its answer. */
async function control(controlPath: string, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${backend}${controlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-Token': testToken ?? '' },
    body: JSON.stringify(body),
  });
  // the backend runs with --test-controls, answering NECESSARY_TEST_TOKEN
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

/** From now on the backend holds each app PIN check once it has claimed its attempt, until releasePinChecks. */
const holdPinChecks = () => control('/test/pin-checks', { hold: true });
/** Releases the checks held -- with [fail], as if their verifier broke. */
const releasePinChecks = (fail = false) => control('/test/pin-checks', { hold: false, fail });

/** Waits until [count] app PIN checks are held. */
async function pinChecksHeld(count: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const answer = await control('/test/pin-checks', {});
    if (answer['waiting'] === count) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`the backend never held ${count} app PIN checks`);
}

/** This backend's own sign-in, under the installation session: its account session for this installation. */
async function signIn(device: DeviceTrust, password = 'correct horse'): Promise<string> {
  const proof = await device.signRequest({
    method: 'POST',
    path: '/v1/demo/sign-in',
    bearer: device.installationSession as string,
    body: JSON.stringify({ handle: `e2e-${randomInt(2 ** 32)}`, password }),
  });
  return (await device.send(proof))['account_session'] as string;
}

/**
 * Refused with [code] -- and, like every refusal here, without naming the check that failed: the
 * phone is told what to do next, never what gave a request away.
 */
async function refused(promise: Promise<unknown>, code: string): Promise<void> {
  let error: unknown = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ApiException);
  const refusal = error as ApiException;
  expect(refusal.code).toBe(code);
  const named = Object.keys(refusal.details ?? {}).filter((name) => name === 'check' || name === 'at');
  expect(named).toEqual([]);
}

const withBackend = backend ? describe : describe.skip;
const withControls = testToken ? test : test.skip;

withBackend(`against ${backend}`, () => {
  test('start registers and proves; a scan is answered with integrity.report_id', async () => {
    const device = trust();
    await device.start();
    const scan = await device.scan();
    expect(scan.reportId).toBeTruthy();
    expect((scan.answer['integrity'] as JsonObject)['next']).toBe('allow');
    // What catches hooks, gadgets and changes in memory is asked for on every scan, never left to chance.
    for (let i = 0; i < 3; i++) {
      expect((await device.scan()).challenge.requiredProbes).toEqual(
        expect.arrayContaining(['runtime_maps', 'frida_ports', 'instrumentation_threads', 'exec_mappings', 'code_integrity', 'tracer', 'debug_state']),
      );
    }
    // Every personal measurement is asked for, so that the example app can show each one it enables.
    expect(scan.challenge.optionalProbes).toEqual([...personalMeasurements]);
  });

  test('a malformed request is answered, never a connection dropped', async () => {
    const answered = async (route: string, body: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`${backend}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await response.json()) as JsonObject).toEqual(expect.objectContaining({ error: expect.any(Object) }));
    };
    // A payload that is valid base64url, of JSON that is no object.
    const notAnObject = base64UrlNoPadding(utf8Encode('[]'));
    await answered('/v1/installations/verify', { payload: notAnObject });
    await answered('/v1/installations/challenge', { installation_id: [] });
    await answered('/v1/installations/register', { installation_id: 5 });
  });

  test('a request carries its proof once', async () => {
    const device = trust();
    await device.start();
    const account = await signIn(device);
    const proof = await device.signRequest({ method: 'POST', path: '/v1/demo/echo', bearer: account, body: '{"hello":1}' });
    expect(await device.send(proof)).toMatchObject({ done: '/v1/demo/echo' });
    await refused(device.send(proof), 'proof_reused');
  });

  test('a scan for one action approves that request, once', async () => {
    const device = trust();
    await device.start();
    const account = await signIn(device);
    const body = '{"amount":25,"to":"payee-7"}';
    const scan = await device.scan({ session: account, operation: describeOperation('POST', '/v1/demo/transfer', body) });
    const transfer = async (reportId: string | null) =>
      device.send(await device.signRequest({ method: 'POST', path: '/v1/demo/transfer', bearer: account, body, reportId }));
    await refused(transfer(null), 'needs_scan');
    expect(await transfer(scan.reportId)).toMatchObject({ done: '/v1/demo/transfer' });
    await refused(transfer(scan.reportId), 'needs_scan');
  });

  test('a scan for one action approves it only when the backend allows it: the contract judges a report before anything else', async () => {
    const body = '{"amount":25,"to":"payee-7"}';
    for (const [name, next] of [
      ['android-8-complete', 'allow'],
      ['android-8-incomplete', 'scan_again'],
      ['android-8-invalid', 'review'],
    ]) {
      const device = trust({ collector: new SampleCollector(name) });
      await device.start();
      const account = await signIn(device);
      const scan = await device.scan({ session: account, operation: describeOperation('POST', '/v1/demo/transfer', body) });
      expect([name, (scan.answer['integrity'] as JsonObject)['next']]).toEqual([name, next]);
      const transfer = device.send(
        await device.signRequest({ method: 'POST', path: '/v1/demo/transfer', bearer: account, body, reportId: scan.reportId }),
      );
      if (next === 'allow') {
        expect(await transfer).toMatchObject({ done: '/v1/demo/transfer' });
      } else {
        await refused(transfer, 'needs_scan');
      }
    }
    // A collector older than the contract is refused, never read.
    const old = trust({ collector: new SampleCollector('android-8-complete', 7) });
    await old.start();
    await refused(old.scan(), 'report_not_accepted');
  });

  withControls('every sample of the contract is judged as it says, under its own plan', async () => {
    const folder = repositoryDirectory(SAMPLES);
    const names = fs
      .readdirSync(folder)
      .filter((name) => name.endsWith('.json'))
      .sort();
    expect(names).toHaveLength(11);
    for (const name of names) {
      const value = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
      const answer = await control('/test/judge', { report: value['report'], required_probes: value['plan']['required_probes'] });
      expect([name, answer['judged']]).toEqual([name, value['expect']]);
    }
  });

  test("a sensitive request needs the person's approval: step-up, the app PIN, or both", async () => {
    const device = trust({ stepUp: new StepUpOptions(), appPin: new AppPinOptions() });
    await device.start();
    const account = await signIn(device, 'pin owner');
    const sensitive = async (options: { stepUp?: boolean; pin?: string } = {}) =>
      device.send(
        await device.signRequest({
          method: 'POST',
          path: '/v1/demo/sensitive',
          bearer: account,
          body: '{"payee":"payee-7"}',
          stepUp: options.stepUp ?? false,
          appPin: options.pin ?? null,
        }),
      );
    await refused(sensitive(), 'needs_approval');
    expect(await sensitive({ stepUp: true })).toMatchObject({ done: '/v1/demo/sensitive' });
    await refused(sensitive({ pin: '135790' }), 'app_pin_not_set');
    expect(await device.setAppPin({ session: account, pin: '135790', reauthentication: { password: 'pin owner' } })).toMatchObject({
      app_pin_set: true,
    });
    await refused(sensitive({ pin: '000000' }), 'app_pin_invalid');
    expect(await sensitive({ pin: '135790' })).toMatchObject({ done: '/v1/demo/sensitive' });
    expect(await sensitive({ stepUp: true, pin: '135790' })).toMatchObject({ done: '/v1/demo/sensitive' });
  });

  test("a request proof is refused for another body, path or time, and under another phone's key", async () => {
    const device = trust();
    await device.start();
    const account = await signIn(device);
    const body = '{"amount":25}';
    const echo = () => device.signRequest({ method: 'POST', path: '/v1/demo/echo', bearer: account, body });
    await refused(device.client.sendSigned(await echo(), { encodedBody: '{"amount":2500}' }), 'proof_not_accepted');
    await refused(device.client.sendSigned(await echo(), { path: '/v1/demo/sensitive' }), 'proof_not_accepted');
    await refused(
      device.send(
        await signRequest({
          identity: device.identity as InstallationIdentity,
          method: 'POST',
          path: '/v1/demo/echo',
          bearerToken: account,
          encodedBody: body,
          timestamp: Math.floor(Date.now() / 1000) - 600,
        }),
      ),
      'proof_not_accepted',
    );
    // The session copied to another phone: its key cannot sign for this installation, even naming it.
    const other = trust();
    await other.start();
    await refused(
      other.send(
        await signRequest({
          identity: other.identity as InstallationIdentity,
          method: 'POST',
          path: '/v1/demo/echo',
          bearerToken: account,
          encodedBody: body,
          installationId: (device.identity as InstallationIdentity).installationId,
        }),
      ),
      'invalid_installation_signature',
    );
  });

  test('re-enrolment: a dead step-up key replaced with the password, for that account alone', async () => {
    const stepUpKey = new SoftwareStepUpKey();
    const device = trust({ stepUp: new StepUpOptions(), stepUpKey });
    await device.start();
    const account = await signIn(device, 'key owner');
    const sensitive = async (session: string) =>
      device.send(
        await device.signRequest({ method: 'POST', path: '/v1/demo/sensitive', bearer: session, body: '{"payee":"payee-7"}', stepUp: true }),
      );
    expect(await sensitive(account)).toMatchObject({ done: '/v1/demo/sensitive' });
    // The screen lock removed: the key the backend holds cannot sign.
    stepUpKey.dead = true;
    await expectNativeCode(sensitive(account), 'STEPUP_KEY_INVALIDATED');
    await refused(device.reenrolStepUp({ session: account, reauthentication: { password: 'wrong password' } }), 'reauthentication_failed');
    expect(await device.reenrolStepUp({ session: account, reauthentication: { password: 'key owner' } })).toMatchObject({
      stepup_key_registered: true,
    });
    expect(await sensitive(account)).toMatchObject({ done: '/v1/demo/sensitive' });
    // Another account on the same phone gains no step-up from it.
    await refused(sensitive(await signIn(device)), 'step_up_not_accepted');
  });

  withControls('an app PIN check settles against the PIN it compared: a PIN set meanwhile is left alone, and the proofs made before it no longer serve', async () => {
    const device = trust({ appPin: new AppPinOptions() });
    await device.start();
    const account = await signIn(device, 'pin owner');
    const setPin = (pin: string) => device.setAppPin({ session: account, pin, reauthentication: { password: 'pin owner' } });
    const unlock = (pin: string): Promise<RequestProof> =>
      device.signRequest({ method: 'POST', path: '/v1/demo/sensitive', bearer: account, body: '{"payee":"payee-7"}', appPin: pin });
    const sensitive = async (pin: string) => device.send(await unlock(pin));
    const done = { done: '/v1/demo/sensitive' };
    await setPin('111111');

    // A right PIN still being checked when a new one is set unlocks nothing; asked now, the old PIN
    // is simply wrong. (Each check held is expected at once, so that its refusal never goes unheard.)
    await holdPinChecks();
    const right = refused(unlock('111111'), 'app_pin_invalid');
    await pinChecksHeld(1);
    await setPin('222222');
    await releasePinChecks();
    await right;
    await refused(sensitive('111111'), 'app_pin_invalid');
    expect(await sensitive('222222')).toMatchObject(done);

    // Five wrong PINs being checked hold every attempt, so a sixth waits; when a new PIN is set
    // meanwhile they neither count against it nor lock it.
    await holdPinChecks();
    const wrong = Array.from({ length: 5 }, (_, i) => refused(unlock(`99999${i}`), 'app_pin_invalid'));
    await pinChecksHeld(5);
    await refused(unlock('999995'), 'pin_busy');
    await setPin('333333');
    await releasePinChecks();
    await Promise.all(wrong);
    expect(await sensitive('333333')).toMatchObject(done);

    // A proof made before a new PIN no longer serves.
    const made = await unlock('333333');
    await setPin('444444');
    await refused(device.send(made), 'app_pin_not_accepted');
    expect(await sensitive('444444')).toMatchObject(done);

    // A check that could not run gives its attempt back: four wrong PINs after it still leave the
    // last attempt, which two checks at once cannot both take.
    await holdPinChecks();
    const broken = refused(unlock('444444'), 'pin_unavailable');
    await pinChecksHeld(1);
    await releasePinChecks(true);
    await broken;
    for (let i = 0; i < 4; i++) {
      await refused(sensitive(`00000${i}`), 'app_pin_invalid');
    }
    await holdPinChecks();
    const last = unlock('444444');
    await pinChecksHeld(1);
    await refused(unlock('444444'), 'pin_busy');
    await releasePinChecks();
    expect(await device.send(await last)).toMatchObject(done);
  });

  test('a screen lock set only after the installation was registered: its step-up key waits for re-enrolment, then approves', async () => {
    const stepUpKey = new SoftwareStepUpKey();
    stepUpKey.locked = false;
    const device = trust({ stepUp: new StepUpOptions(), stepUpKey });
    await device.start();
    expect(device.stepUpUnavailable?.code).toBe('STEPUP_NO_DEVICE_CREDENTIAL');
    const account = await signIn(device, 'lock owner');
    // The lock set again, the app started again: the key it makes now is not one the backend took.
    stepUpKey.locked = true;
    await device.start();
    expect(device.stepUpUnavailable?.code).toBe('STEPUP_REENROL_PENDING');
    const sensitive = async () =>
      device.send(
        await device.signRequest({ method: 'POST', path: '/v1/demo/sensitive', bearer: account, body: '{"payee":"payee-7"}', stepUp: true }),
      );
    await expectNativeCode(sensitive(), 'STEPUP_REENROL_PENDING');
    expect(await device.reenrolStepUp({ session: account, reauthentication: { password: 'lock owner' } })).toMatchObject({
      stepup_key_registered: true,
    });
    expect(await sensitive()).toMatchObject({ done: '/v1/demo/sensitive' });
  });

  withControls("the guide's protocol errors, each acted on once", async () => {
    const device = trust();
    await device.start();
    // The installation session expired: the key is proved again.
    await control('/test/expire-sessions', {});
    expect((await device.scan()).reportId).toBeTruthy();
    // The backend lost the installation: registered again with the same key.
    await control('/test/forget', { installation_id: (device.identity as InstallationIdentity).installationId });
    expect((await device.scan()).reportId).toBeTruthy();
    // A key challenge expired before its answer: a new one, once.
    await control('/test/refuse-next', { path: '/v1/installations/verify', status: 401, code: 'challenge_expired' });
    expect(await device.prove()).toBeTruthy();
    // A scan's challenge expired before its report: a new scan, once.
    await control('/test/refuse-next', { path: '/v1/integrity/report', status: 401, code: 'integrity_challenge_expired' });
    expect((await device.scan()).reportId).toBeTruthy();
    // A short wait is waited out, once.
    await control('/test/refuse-next', {
      path: '/v1/integrity/challenge',
      status: 429,
      code: 'busy',
      details: { retry_after_seconds: 1 },
    });
    expect((await device.scan()).reportId).toBeTruthy();
    // Any other refusal reaches the app as it came.
    await control('/test/refuse-next', { path: '/v1/integrity/challenge', status: 403, code: 'installation_inactive' });
    await refused(device.scan(), 'installation_inactive');
  });
});
