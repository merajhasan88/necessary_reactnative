// The SDK's reports against the published measurement contract: from the collector answer in each
// sample of contract/report-1/android-8-ios-5/, the SDK builds that sample's report -- every member
// but the phone's clock. The SDK judges nothing: an invalid or refused sample is built just as
// faithfully.
import * as fs from 'fs';
import * as path from 'path';
import {
  collectReport,
  InstallationIdentity,
  NativeInstallationKey,
  NativeIntegrityCollector,
  NativeKeyMetadata,
  ScanChallenge,
} from '../src';
import { base64UrlDecode, utf8Decode } from '../src/util/bytes';
import { repositoryDirectory } from './support/repositoryFiles';

class Key extends NativeInstallationKey {
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    throw new Error('unimplemented');
  }
  override async signPayload(): Promise<string> {
    return 'signed';
  }
  override async deleteKey(): Promise<void> {}
}

/** Answers what the sample's collector answered. */
class Recorded extends NativeIntegrityCollector {
  constructor(private readonly report: Record<string, any>) {
    super();
  }
  override async collect(args: { challengeNonce: string }): Promise<Record<string, unknown>> {
    return {
      platform: this.report['platform'],
      challenge_nonce_echo: args.challengeNonce,
      collector_version: this.report['collector_version'],
      probes: this.report['probe_results'],
    };
  }
}

const folder = repositoryDirectory('contract/report-1/android-8-ios-5/samples');
const samples = fs
  .readdirSync(folder)
  .filter((name) => name.endsWith('.json'))
  .sort();

test('the contract has its samples', () => expect(samples).toHaveLength(11));

for (const name of samples) {
  const sample = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'));
  const expected = sample['report'];
  const plan = sample['plan'];
  test(name, async () => {
    const built = await collectReport({
      challenge: ScanChallenge.fromJson({
        challenge_id: expected['challenge_id'],
        nonce: expected['challenge_nonce'],
        platform: expected['platform'],
        required_probes: plan['required_probes'],
        optional_probes: plan['optional_probes'],
      }),
      identity: new InstallationIdentity({
        installationId: expected['installation_id'],
        nativeKey: new Key(),
        metadata: new NativeKeyMetadata({
          publicKey: {},
          algorithm: 'ES256',
          keyAlias: 'sample',
          provider: 'sample',
          securityLevel: 'software',
          hardwareBacked: false,
          privateKeyExportable: false,
          signatureFormat: 'der',
          created: false,
        }),
      }),
      collector: new Recorded(expected),
      enabledMeasurements: [...expected['enabled_measurements']],
    });
    expect(Number.isInteger(built.report['collected_at'])).toBe(true);
    expect({ ...built.report, collected_at: expected['collected_at'] }).toEqual(expected);
    // the payload is the report, as signed
    expect(JSON.parse(utf8Decode(base64UrlDecode(built.payload)))).toEqual(built.report);
  });
}
