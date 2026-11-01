// DeviceTrust against a backend that answers as the public guide says, with the phone's native side
// replaced: what it sends, under which session, and what it does about each of the guide's protocol
// errors.
import {
  ApiException,
  AppPinOptions,
  describeOperation,
  InterruptedCallException,
  NativeKeyException,
  PersonalMeasurement,
  personalMeasurements,
  StepUpOptions,
} from '../src';
import { sha256Hex } from '../src/util/bytes';
import {
  approve,
  Backend,
  CancelledStepUpKey,
  Collector,
  completer,
  decoded,
  delay,
  DyingStepUpKey,
  expectNativeCode,
  FlakyStepUpKey,
  HeldBackend,
  refusal,
  StepUpKey,
  Store,
  trustOver,
  UnavailableStepUpKey,
} from './support/fakes';
import { readJson } from './support/repositoryFiles';

test('start registers the key -- with the step-up key -- and proves it', async () => {
  const backend = new Backend();
  const trust = trustOver(backend, { stepUp: new StepUpOptions() });
  await trust.start();
  expect(backend.paths).toEqual(['/v1/installations/register', '/v1/installations/challenge', '/v1/installations/verify']);
  const registration = backend.calls[0].body;
  expect(registration['installation_id']).toBe('proposed-id');
  expect(registration['platform']).toBe('android');
  expect(registration['public_key']).toMatchObject({ kty: 'EC' });
  expect(registration['reinstall_hint']).toEqual({ kind: 'android_id_sha256', value: 'hint' });
  expect(registration['key_security']).toMatchObject({ hardware_backed: true });
  expect(registration['stepup_public_key']).toMatchObject({ x: 'sx' });
  expect(registration['stepup_key_auth']).toEqual({ factor: 'passcode', mode: 'per_use', window_seconds: 0 });
  expect(backend.calls[2].body['signature']).toBe('signed');
  expect(trust.installationSession).toBe('installation-session');
});

test('the installation the backend holds for the key is kept', async () => {
  const store = new Store();
  const answers: Record<string, unknown>[] = [];
  const backend = new Backend({ '/v1/installations/register': [{ installation_id: 'held-id', more: 1 }] });
  const trust = trustOver(backend, { store, onRegistered: (answer) => void answers.push(answer) });
  await trust.start();
  expect(trust.identity?.installationId).toBe('held-id');
  expect(store.saved).toBe('held-id');
  expect(backend.calls[1].body['installation_id']).toBe('held-id');
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ more: 1 });
});

test("a scan: under the installation session, the enabled measurements in the guide's order, the report id from integrity", async () => {
  const backend = new Backend();
  const collector = new Collector();
  const trust = trustOver(backend, {
    collector,
    personal: [PersonalMeasurement.mockLocation, PersonalMeasurement.localAddresses],
  });
  await trust.start();
  const scan = await trust.scan();
  expect(collector.enabled).toEqual(['local_addresses', 'mock_location']);
  const challenge = backend.calls[3];
  expect(challenge.path).toBe('/v1/integrity/challenge');
  expect(challenge.bearer).toBe('installation-session');
  expect(challenge.body).toEqual({});
  expect(Object.keys(challenge.headers)).toContain('X-Access-Proof');
  const report = backend.calls[4];
  expect(report.bearer).toBe('installation-session');
  const signed = decoded(report.body['report_payload'] as string);
  expect(signed['challenge_id']).toBe('scan-challenge');
  expect(signed['enabled_measurements']).toEqual(['local_addresses', 'mock_location']);
  expect(scan.reportId).toBe('report-1');
});

test('the personal measurements change with the app: the next scan follows, the installation and its step-up key stay', async () => {
  const backend = new Backend();
  const collector = new Collector();
  const trust = trustOver(backend, { collector, stepUp: new StepUpOptions() });
  await trust.start();
  await trust.scan();
  expect(collector.enabled).toEqual([]);
  trust.personalMeasurements = new Set([PersonalMeasurement.location, PersonalMeasurement.accessibility]);
  await trust.scan();
  expect(collector.enabled).toEqual(['accessibility', 'location']);
  expect(trust.stepUpKey).not.toBeNull();
  expect(backend.paths.filter((path) => path.startsWith('/v1/installations'))).toHaveLength(3);
});

test("re-enrolment: a dead step-up key replaced, its proof bound to the request proof's nonce, and approvals from then on", async () => {
  const backend = new Backend();
  const key = new DyingStepUpKey();
  const trust = trustOver(backend, { stepUpKey: key, stepUp: new StepUpOptions() });
  await trust.start();
  expect(await trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } })).toMatchObject({
    stepup_key_registered: true,
  });
  expect(key.deleted).toBe(1);
  const call = backend.calls[backend.calls.length - 1];
  expect(call.path).toBe('/v1/installations/stepup-key');
  expect(call.bearer).toBe('account-session');
  expect(call.body['password']).toBe('pw');
  expect(call.body['stepup_public_key']).toMatchObject({ x: 'sx' });
  expect(call.body['stepup_key_auth']).toMatchObject({ factor: 'passcode' });
  expect(call.body['stepup_key_signature']).toBe('approved');
  const proof = decoded(call.body['stepup_key_proof'] as string);
  expect(proof['version']).toBe(1);
  expect(proof['purpose']).toBe('stepup_reenrol');
  expect(proof['installation_id']).toBe('proposed-id');
  expect(proof['nonce']).toBe(decoded(call.headers['X-Access-Proof'])['nonce']);
  const approval = await trust.signRequest({ method: 'POST', path: '/v1/pay', bearer: 'account-session', stepUp: true });
  expect(Object.keys(approval.headers)).toContain('X-Step-Up-Proof');
});

test('a step-up key the keystore cannot vouch for is kept at start, and replaced only by a re-enrolment', async () => {
  const backend = new Backend();
  const key = new UnavailableStepUpKey();
  const trust = trustOver(backend, { stepUpKey: key, stepUp: new StepUpOptions() });
  await trust.start();
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_KEY_UNAVAILABLE');
  expect(key.deleted).toBe(0);
  expect(await trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } })).toMatchObject({
    stepup_key_registered: true,
  });
  expect(key.deleted).toBe(1);
  expect(trust.stepUpUnavailable).toBeNull();
});

test('a re-enrolment the backend refused leaves approvals waiting for it, across a restart too, until a second one succeeds', async () => {
  const backend = new Backend({
    '/v1/installations/stepup-key': [refusal('reauthentication_failed', 401), { stepup_key_registered: true }],
  });
  const store = new Store();
  const key = new DyingStepUpKey();
  const started = () => trustOver(backend, { store, stepUpKey: key, stepUp: new StepUpOptions() });
  const trust = started();
  await trust.start();
  await expect(trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'wrong' } })).rejects.toBeInstanceOf(
    ApiException,
  );
  // The dead key is gone and the new one not taken: approvals wait.
  await expectNativeCode(approve(trust), 'STEPUP_REENROL_PENDING');
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_REENROL_PENDING');
  const restarted = started();
  await restarted.start();
  await expectNativeCode(approve(restarted), 'STEPUP_REENROL_PENDING');
  expect(await restarted.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } })).toMatchObject({
    stepup_key_registered: true,
  });
  expect(store.reenrolPending).toBe(false);
  expect(restarted.stepUpUnavailable).toBeNull();
  expect(Object.keys((await approve(restarted)).headers)).toContain('X-Step-Up-Proof');
});

test('a re-enrolment whose prompt was cancelled, then whose answer was lost, is finished by the next one', async () => {
  const backend = new Backend({
    '/v1/installations/stepup-key': [refusal('bad_gateway', 502), { stepup_key_registered: true }],
  });
  const store = new Store();
  const trust = trustOver(backend, { store, stepUpKey: new CancelledStepUpKey(), stepUp: new StepUpOptions() });
  await trust.start();
  const reenrol = () => trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } });
  await expectNativeCode(reenrol(), 'STEPUP_CANCELLED');
  await expectNativeCode(approve(trust), 'STEPUP_REENROL_PENDING');
  await expect(reenrol()).rejects.toBeInstanceOf(ApiException);
  await expectNativeCode(approve(trust), 'STEPUP_REENROL_PENDING');
  expect(store.reenrolPending).toBe(true);
  expect(await reenrol()).toMatchObject({ stepup_key_registered: true });
  expect(store.reenrolPending).toBe(false);
  expect(Object.keys((await approve(trust)).headers)).toContain('X-Step-Up-Proof');
});

test('a backend that says it does not hold the step-up key offered leaves approvals waiting for re-enrolment; one that says it does clears that', async () => {
  const backend = new Backend({
    '/v1/installations/register': [
      { installation_id: 'proposed-id', stepup_key_registered: false, stepup_key_matches: false },
      { installation_id: 'proposed-id', stepup_key_registered: true, stepup_key_matches: true },
    ],
  });
  const store = new Store();
  const trust = trustOver(backend, { store, stepUp: new StepUpOptions() });
  await trust.start();
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_REENROL_PENDING');
  await expectNativeCode(approve(trust), 'STEPUP_REENROL_PENDING');
  expect(store.reenrolPending).toBe(true);
  await trust.start();
  expect(trust.stepUpUnavailable).toBeNull();
  expect(store.reenrolPending).toBe(false);
  expect(Object.keys((await approve(trust)).headers)).toContain('X-Step-Up-Proof');
});

test('a step-up key the phone could not make at registration, made at the next start, waits for re-enrolment even where the backend says nothing', async () => {
  const backend = new Backend();
  const store = new Store();
  const trust = trustOver(backend, { store, stepUp: new StepUpOptions(), stepUpKey: new FlakyStepUpKey() });
  await trust.start();
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_NO_DEVICE_CREDENTIAL');
  await trust.start();
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_REENROL_PENDING');
  await expectNativeCode(approve(trust), 'STEPUP_REENROL_PENDING');
  expect(await trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } })).toMatchObject({
    stepup_key_registered: true,
  });
  expect(Object.keys((await approve(trust)).headers)).toContain('X-Step-Up-Proof');
});

test('reset deletes the step-up key with the installation: nothing links the next installation to this one', async () => {
  const key = new DyingStepUpKey();
  const trust = trustOver(new Backend(), { stepUpKey: key, stepUp: new StepUpOptions() });
  await trust.start();
  await trust.reset();
  expect(key.deleted).toBe(1);
  expect(trust.stepUpKey).toBeNull();
});

test('a reset while a re-enrolment waits for its answer waits for it, then deletes its key and its marker', async () => {
  const answer = completer();
  const backend = new HeldBackend('/v1/installations/stepup-key', answer.promise);
  const store = new Store();
  const key = new DyingStepUpKey();
  const trust = trustOver(backend, { store, stepUpKey: key, stepUp: new StepUpOptions() });
  await trust.start();
  const reenrolled = expect(
    trust.reenrolStepUp({ session: 'account-session', reauthentication: { password: 'pw' } }),
  ).rejects.toBeInstanceOf(InterruptedCallException);
  await backend.asked;
  expect(store.reenrolPending).toBe(true);
  expect(key.deleted).toBe(1);
  let reset = false;
  const resetting = trust.reset().then(() => (reset = true));
  await delay(20);
  expect(reset).toBe(false); // the reset waits for the re-enrolment
  answer.complete();
  await reenrolled;
  await resetting;
  expect(store.reenrolPending).toBe(false);
  expect(key.deleted).toBe(2); // the re-enrolled key deleted after it
});

test('re-enrolment with step-up off refuses before sending', async () => {
  const backend = new Backend();
  const trust = trustOver(backend);
  await trust.start();
  await expectNativeCode(trust.reenrolStepUp({ session: 'account-session' }), 'STEPUP_OFF');
  expect(backend.paths).not.toContain('/v1/installations/stepup-key');
});

test('a scan for one operation is asked under the account session', async () => {
  const backend = new Backend();
  const trust = trustOver(backend);
  await trust.start();
  const operation = describeOperation('POST', '/v1/pay', '{"amount":5}');
  expect(() => trust.scan({ operation })).toThrow(TypeError);
  await trust.scan({ session: 'account-session', operation });
  const challenge = backend.calls[3];
  expect(challenge.bearer).toBe('account-session');
  expect(challenge.body['operation']).toEqual(operation);
  expect(backend.calls[4].bearer).toBe('account-session');
});

test('an expired installation session is proved again, once; an expired account session goes to the app', async () => {
  const backend = new Backend({
    '/v1/integrity/challenge': [
      refusal('expired_token', 401),
      { challenge_id: 'scan-challenge', nonce: 'bm9uY2U', platform: 'android', required_probes: ['app_identity'] },
    ],
  });
  const trust = trustOver(backend);
  await trust.start();
  await trust.scan();
  expect(backend.paths.slice(3)).toEqual([
    '/v1/integrity/challenge',
    '/v1/installations/challenge',
    '/v1/installations/verify',
    '/v1/integrity/challenge',
    '/v1/integrity/report',
  ]);

  const account = new Backend({ '/v1/integrity/challenge': [refusal('expired_token', 401)] });
  const other = trustOver(account);
  await other.start();
  const scanning = other.scan({ session: 'account-session', operation: {} });
  await expect(scanning).rejects.toBeInstanceOf(ApiException);
  await scanning.catch((error: ApiException) => expect(error.code).toBe('expired_token'));
  expect(account.paths.filter((path) => path === '/v1/installations/verify')).toHaveLength(1);
});

test('a lost installation registers again under the installation session, never under an account session', async () => {
  const backend = new Backend({
    '/v1/integrity/challenge': [
      refusal('installation_not_found', 404),
      { challenge_id: 'scan-challenge', nonce: 'bm9uY2U', platform: 'android', required_probes: ['app_identity'] },
    ],
  });
  const trust = trustOver(backend);
  await trust.start();
  await trust.scan();
  expect(backend.paths.slice(3, 7)).toEqual([
    '/v1/integrity/challenge',
    '/v1/installations/register',
    '/v1/installations/challenge',
    '/v1/installations/verify',
  ]);

  const account = new Backend({ '/v1/integrity/challenge': [refusal('installation_not_found', 404)] });
  const other = trustOver(account);
  await other.start();
  await expect(other.scan({ session: 'account-session', operation: {} })).rejects.toBeInstanceOf(ApiException);
  expect(account.paths.filter((path) => path === '/v1/installations/register')).toHaveLength(1);
});

test('a short wait is waited out once; a long one goes to the app', async () => {
  const backend = new Backend({
    '/v1/integrity/report': [
      refusal('too_many', 429, { retry_after_seconds: 0 }),
      { integrity: { report_id: 'report-2' } },
    ],
  });
  const trust = trustOver(backend);
  await trust.start();
  expect((await trust.scan()).reportId).toBe('report-2');

  const slow = new Backend({ '/v1/integrity/report': [refusal('too_many', 429, { retry_after_seconds: 30 })] });
  const other = trustOver(slow);
  await other.start();
  await expect(other.scan()).rejects.toBeInstanceOf(ApiException);
  expect(slow.paths.filter((path) => path === '/v1/integrity/report')).toHaveLength(1);
});

test('a refusal outside the guide goes to the app as it came', async () => {
  const backend = new Backend({ '/v1/installations/register': [refusal('try_again_later', 409)] });
  const starting = trustOver(backend).start();
  await expect(starting).rejects.toBeInstanceOf(ApiException);
  await starting.catch((error: ApiException) => expect(error.code).toBe('try_again_later'));
  expect(backend.paths).toEqual(['/v1/installations/register']);
});

test("a signed request: the person approves first, the request proof after on the same nonce; the PIN's proof and the report join it", async () => {
  const backend = new Backend({ '/v1/pay': [{ paid: true }] });
  const key = new StepUpKey();
  const trust = trustOver(backend, { stepUpKey: key, stepUp: new StepUpOptions(), appPin: new AppPinOptions() });
  await trust.start();
  const proof = await trust.signRequest({
    method: 'post',
    path: '/v1/pay',
    bearer: 'account-session',
    body: '{"amount":5}',
    stepUp: true,
    reason: 'Approve the payment',
    appPin: '246810',
    reportId: 'report-1',
  });
  const access = decoded(proof.headers['X-Access-Proof']);
  const stepUp = decoded(proof.headers['X-Step-Up-Proof']);
  expect(stepUp['nonce']).toBe(access['nonce']);
  expect(stepUp['method']).toBe('POST');
  expect(stepUp['factor']).toBe('passcode');
  expect(proof.headers['X-Step-Up-Signature']).toBe('approved');
  expect(key.reason).toBe('Approve the payment');
  expect(proof.headers['X-App-PIN-Proof']).toBe('pin-proof');
  expect(proof.headers['X-Integrity-Report']).toBe('report-1');
  const pin = backend.calls[backend.calls.length - 1];
  expect(pin.path).toBe('/v1/account/app-pin/proof');
  expect(pin.bearer).toBe('account-session');
  expect(pin.body).toEqual({
    pin: '246810',
    request: { method: 'POST', path: '/v1/pay', query: '', body_sha256: sha256Hex('{"amount":5}'), nonce: access['nonce'] },
  });
  await trust.send(proof);
  expect(backend.calls[backend.calls.length - 1].path).toBe('/v1/pay');
  expect(backend.calls[backend.calls.length - 1].headers).toEqual(proof.headers);
});

test('step-up and the app PIN are options: off, they refuse', async () => {
  const trust = trustOver(new Backend());
  await trust.start();
  await expect(trust.signRequest({ method: 'POST', path: '/p', bearer: 'b', stepUp: true })).rejects.toBeInstanceOf(
    NativeKeyException,
  );
  await expect(trust.signRequest({ method: 'POST', path: '/p', bearer: 'b', appPin: '1' })).rejects.toThrow(
    'The app PIN is off',
  );
  await expect(trust.setAppPin({ session: 'b', pin: '1' })).rejects.toThrow('The app PIN is off');
});

test('the app PIN is set with the re-authentication the app gives', async () => {
  const backend = new Backend();
  const trust = trustOver(backend, { appPin: new AppPinOptions() });
  await trust.start();
  await trust.setAppPin({ session: 'account-session', pin: '246810', reauthentication: { password: 'secret' } });
  const last = backend.calls[backend.calls.length - 1];
  expect(last.path).toBe('/v1/account/app-pin');
  expect(last.bearer).toBe('account-session');
  expect(last.body).toEqual({ password: 'secret', pin: '246810' });
});

test('a phone that cannot make the step-up key registers without it', async () => {
  const backend = new Backend();
  const trust = trustOver(backend, {
    stepUp: new StepUpOptions(),
    stepUpKey: new StepUpKey(new NativeKeyException('STEPUP_NO_DEVICE_CREDENTIAL', 'no screen lock')),
  });
  await trust.start();
  expect('stepup_public_key' in backend.calls[0].body).toBe(false);
  expect(trust.stepUpUnavailable?.code).toBe('STEPUP_NO_DEVICE_CREDENTIAL');
  expect(trust.installationSession).toBe('installation-session');
});

test('a step-up key the phone could not make at registration is not made later for a request, which the backend could not check', async () => {
  const backend = new Backend();
  const key = new FlakyStepUpKey();
  const trust = trustOver(backend, { stepUp: new StepUpOptions(), stepUpKey: key });
  await trust.start();
  expect('stepup_public_key' in backend.calls[0].body).toBe(false);
  await expectNativeCode(trust.signRequest({ method: 'POST', path: '/p', bearer: 'b', stepUp: true }), 'STEPUP_NO_DEVICE_CREDENTIAL');
  expect(key.attempts).toBe(1);
});

test("the personal measurements are the published contract's", () => {
  const schema = readJson('contract/report-1/android-8-ios-5/report.schema.json');
  expect([...personalMeasurements]).toEqual(schema['properties']['enabled_measurements']['items']['enum']);
});
