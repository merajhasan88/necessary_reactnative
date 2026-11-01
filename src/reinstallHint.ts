/**
 * The reinstall hint: a SHA-256 of the platform's per-app device identifier, which the backend
 * keys before storing. Client input, never proof.
 */

import { sha256Hex } from './util/bytes';
import { currentPlatform, installationKeyModule } from './util/native';

export class ReinstallHint {
  readonly kind: string;
  readonly value: string;

  constructor(value: { kind: string; value: string }) {
    this.kind = value.kind;
    this.value = value.value;
  }

  toJSON(): Record<string, unknown> {
    return { kind: this.kind, value: this.value };
  }
}

export class ReinstallHintReader {
  private readonly platform: () => string;
  private readonly identifier: () => Promise<string>;

  /** [platform] and [identifier] replace the phone's in tests. */
  constructor(options: { platform?: () => string; identifier?: () => Promise<string> } = {}) {
    this.platform = options.platform ?? currentPlatform;
    this.identifier =
      options.identifier ??
      (async () => {
        const native = installationKeyModule();
        return native === null ? '' : await native.reinstallHintIdentifier();
      });
  }

  async read(): Promise<ReinstallHint | null> {
    // The phone's per-app identifier: ANDROID_ID, or the identifier for vendor on iOS.
    let kind: string;
    let platform: string;
    try {
      platform = this.platform();
    } catch {
      return null;
    }
    switch (platform) {
      case 'android':
        kind = 'android_id';
        break;
      case 'ios':
        kind = 'idfv';
        break;
      default:
        return null;
    }
    try {
      const value = ((await this.identifier()) ?? '').trim().toLowerCase();
      if (value.length === 0) {
        return null;
      }
      const digest = sha256Hex(`device-recognition-hint-v1|${kind}|${value}`);
      return new ReinstallHint({ kind: `${kind}_sha256`, value: digest });
    } catch {
      // A missing hint must never stop cryptographic installation identity.
    }
    return null;
  }
}
