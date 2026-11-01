// The reinstall hint's bytes: what a backend keys and stores to link reinstalls, so a phone's hint
// must not change when the SDK's code does. The digests are computed apart, by Python's hashlib.
import { ReinstallHintReader } from '../src';

const reader = (platform: string, identifier: string | null): ReinstallHintReader =>
  new ReinstallHintReader({ platform: () => platform, identifier: async () => identifier as string });

test('Android: ANDROID_ID, trimmed and in lower case', async () => {
  const hint = await reader('android', ' 9774D56D682E549C ').read();
  expect(hint?.kind).toBe('android_id_sha256');
  expect(hint?.value).toBe('fe8339ee3d9adfd02d18c670d45a27b139a58455c395e2972a14529d76316d24');
});

test('iOS: the identifier for vendor, in lower case', async () => {
  const hint = await reader('ios', '6F0C2A1E-7B3D-4C5E-9F8A-1B2C3D4E5F60').read();
  expect(hint?.kind).toBe('idfv_sha256');
  expect(hint?.value).toBe('a67ac309e7a6b8cac7fbf58e8d964b07bd525408624d1957f3a8fe7c670461e5');
});

test('no identifier, or another platform: no hint', async () => {
  expect(await reader('android', '').read()).toBeNull();
  expect(await reader('android', null).read()).toBeNull();
  expect(await reader('linux', '9774d56d682e549c').read()).toBeNull();
});
