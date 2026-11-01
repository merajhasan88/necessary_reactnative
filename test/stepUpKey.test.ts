// When the app replaces a step-up key its options do not accept (replacesStepUpKey). Under a
// per-use passcode policy, which Android 9 cannot make a key for, the registration that follows each
// re-enrolment must not replace the key the server has just bound, or step-up stays unavailable.
import { replacesStepUpKey, StepUpKeyMetadata, StepUpOptions } from '../src';

const key = (mode = 'windowed', created = false): StepUpKeyMetadata =>
  new StepUpKeyMetadata({
    publicKey: { kty: 'EC', crv: 'P-256', alg: 'ES256', x: 'x', y: 'y' },
    factor: 'passcode',
    mode,
    windowSeconds: mode === 'windowed' ? 30 : 0,
    securityLevel: 'tee',
    hardwareBacked: true,
    created,
  });
const perUse = new StepUpOptions();

test('a known installation keeps a key the options want more of', () => {
  expect(replacesStepUpKey(key(), perUse, { replaceMismatched: false, knownInstallation: true })).toBe(false);
});

test('a re-enrolment replaces it, and binds the new one', () => {
  expect(replacesStepUpKey(key(), perUse, { replaceMismatched: true, knownInstallation: true })).toBe(true);
});

test("an installation's first registration replaces it", () => {
  expect(replacesStepUpKey(key(), perUse, { replaceMismatched: false, knownInstallation: false })).toBe(true);
});

test('a key just made, or one the options accept, is never replaced', () => {
  for (const known of [true, false]) {
    expect(replacesStepUpKey(key('windowed', true), perUse, { replaceMismatched: true, knownInstallation: known })).toBe(false);
    expect(replacesStepUpKey(key('per_use'), perUse, { replaceMismatched: true, knownInstallation: known })).toBe(false);
  }
});
