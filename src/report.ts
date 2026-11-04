/** The scan (the public guide, section 2): your backend's challenge, the measurements it asks for, and the report the installation key signs. */

import type { NativeIntegrityCollector } from './collector';
import { ApiException } from './errors';
import { answerText } from './util/answers';
import { base64UrlNoPadding, utf8Encode } from './util/bytes';
import { isObject } from './util/native';
import type { InstallationIdentity } from './installationKey';

/** The most a backend takes: a report of 65,536 bytes of JSON (the measurement contract, section 1). */
export const reportByteLimit = 65536;

/**
 * The lists a report may shorten, by measurement -- each beside the `truncated` flag that says the
 * phone had more (the measurement contract, section 6).
 */
export const shortenableLists: Readonly<Record<string, readonly string[]>> = {
  accessibility: ['services', 'settings_only'],
  notification_access: ['listeners'],
  other_access: ['device_admins', 'remote_access_apps'],
};

/**
 * [report] made to fit [reportByteLimit]: the longest list it may shorten is halved, and marked
 * `truncated`, until it fits. A report that cannot fit is never cut anywhere else: the answer is an
 * error naming the limit.
 */
export function fitReport(report: Record<string, unknown>): Record<string, unknown> {
  const probes: Record<string, unknown> = { ...(report['probe_results'] as Record<string, unknown>) };
  const fitted: Record<string, unknown> = { ...report, probe_results: probes };
  const size = (): number => utf8Encode(JSON.stringify(fitted)).length;
  for (let bytes = size(); bytes > reportByteLimit; bytes = size()) {
    let probe: string | null = null;
    let field: string | null = null;
    let longest = 0;
    for (const [name, fields] of Object.entries(shortenableLists)) {
      const result = probes[name];
      for (const list of fields) {
        const items = isObject(result) ? result[list] : undefined;
        if (Array.isArray(items) && items.length > longest) {
          probe = name;
          field = list;
          longest = items.length;
        }
      }
    }
    if (probe === null || field === null) {
      throw new ApiException(`The report would be ${bytes} bytes; a backend takes at most ${reportByteLimit}.`, {
        code: 'report_too_large',
        details: { bytes, limit: reportByteLimit },
      });
    }
    const shortened: Record<string, unknown> = { ...(probes[probe] as Record<string, unknown>) };
    shortened[field] = (shortened[field] as unknown[]).slice(0, Math.floor(longest / 2));
    shortened['truncated'] = true;
    probes[probe] = shortened;
  }
  return fitted;
}

/** A challenge for a scan, as your backend sent it. */
export class ScanChallenge {
  readonly challengeId: string;
  readonly nonce: string;
  readonly platform: string;
  /** The measurements the report must answer. */
  readonly requiredProbes: string[];
  /** The personal measurements asked for, answered only where the app enabled them; none from a backend that names none. */
  readonly optionalProbes: string[];
  /** The challenge whole. */
  readonly answer: Record<string, unknown>;

  constructor(value: {
    challengeId: string;
    nonce: string;
    platform: string;
    requiredProbes: string[];
    optionalProbes: string[];
    answer: Record<string, unknown>;
  }) {
    this.challengeId = value.challengeId;
    this.nonce = value.nonce;
    this.platform = value.platform;
    this.requiredProbes = value.requiredProbes;
    this.optionalProbes = value.optionalProbes;
    this.answer = value.answer;
  }

  static fromJson(value: Record<string, unknown>): ScanChallenge {
    const names = (list: unknown): string[] => (Array.isArray(list) ? list.map((item) => String(item)) : []);
    return new ScanChallenge({
      challengeId: answerText(value, 'challenge_id'),
      nonce: answerText(value, 'nonce'),
      platform: answerText(value, 'platform'),
      requiredProbes: names(value['required_probes']),
      optionalProbes: names(value['optional_probes']),
      answer: value,
    });
  }
}

/** A report as the installation key signed it. */
export class SignedReport {
  /** The report, as signed. */
  readonly report: Record<string, unknown>;
  /** `report_payload`: the base64url of the report's JSON bytes. */
  readonly payload: string;
  /** `report_signature`. */
  readonly signature: string;

  constructor(value: { report: Record<string, unknown>; payload: string; signature: string }) {
    this.report = value.report;
    this.payload = value.payload;
    this.signature = value.signature;
  }

  toJSON(): Record<string, unknown> {
    return { report_payload: this.payload, report_signature: this.signature };
  }
}

/**
 * Measures what [challenge] asks for -- and, of the personal measurements it asks for, those in
 * [enabledMeasurements] -- and signs the report with [identity]'s key.
 */
export async function collectReport(args: {
  challenge: ScanChallenge;
  identity: InstallationIdentity;
  collector: NativeIntegrityCollector;
  enabledMeasurements: string[];
}): Promise<SignedReport> {
  const { challenge, identity, collector, enabledMeasurements } = args;
  const native = await collector.collect({
    requiredProbes: challenge.requiredProbes,
    challengeNonce: challenge.nonce,
    enabledMeasurements,
    optionalProbes: challenge.optionalProbes,
  });
  if (!isObject(native['probes'])) {
    throw new ApiException('The native collector returned no probe map.', {
      code: 'invalid_native_integrity_result',
    });
  }
  if (native['platform'] !== challenge.platform || native['challenge_nonce_echo'] !== challenge.nonce) {
    throw new ApiException('The native integrity response did not match the server challenge.', {
      code: 'integrity_challenge_binding_failed',
    });
  }
  const version = native['collector_version'];
  if (version != null && typeof version !== 'number') {
    throw new TypeError('The native collector returned an invalid collector_version.');
  }

  const report = fitReport({
    challenge_id: challenge.challengeId,
    challenge_nonce: challenge.nonce,
    installation_id: identity.installationId,
    platform: challenge.platform,
    collector_version: typeof version === 'number' ? Math.trunc(version) : 1,
    collected_at: Math.floor(Date.now() / 1000),
    probe_results: { ...(native['probes'] as Record<string, unknown>) },
    // The personal measurements this app enabled, whether or not this scan asked for them.
    enabled_measurements: enabledMeasurements,
    version: 1,
  });
  const payload = base64UrlNoPadding(utf8Encode(JSON.stringify(report)));
  return new SignedReport({ report, payload, signature: await identity.signPayload(payload) });
}
