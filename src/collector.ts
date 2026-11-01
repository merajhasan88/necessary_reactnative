/** The native integrity collector: measures what a challenge asks for and the app enabled, and nothing else. */

import { NativeKeyException } from './errors';
import { integrityModule, isObject, nativeFailure } from './util/native';

const INTEGRITY_MODULE_MISSING = (): NativeKeyException =>
  new NativeKeyException(
    'NATIVE_INTEGRITY_PLUGIN_MISSING',
    "The SDK's integrity module is not linked into this app: rebuild the app.",
  );

export class NativeIntegrityCollector {
  /**
   * [enabledMeasurements]: the personal measurements this app's developers allow; with
   * [optionalProbes], what the backend asks for, the collector measures only what is in both.
   */
  async collect(args: {
    requiredProbes: string[];
    challengeNonce: string;
    enabledMeasurements: string[];
    optionalProbes?: string[];
  }): Promise<Record<string, unknown>> {
    const native = integrityModule();
    if (native === null) {
      throw INTEGRITY_MODULE_MISSING();
    }
    let value: unknown;
    try {
      // What the server asks for and what this app allows; the native collector measures only what
      // is in both.
      value = await native.collect(
        args.requiredProbes,
        args.challengeNonce,
        args.optionalProbes ?? [],
        args.enabledMeasurements,
      );
    } catch (error) {
      throw nativeFailure(error, 'The native integrity collector failed.');
    }
    if (!isObject(value)) {
      throw new NativeKeyException(
        'EMPTY_INTEGRITY_RESPONSE',
        'The native integrity collector returned no measurements.',
      );
    }
    return value;
  }

  /**
   * Asks the person for the OS location permission and returns what the app now holds: precise,
   * approximate or none. Only the app asks, from its own screen; a scan never prompts.
   */
  async requestLocationPermission(): Promise<string> {
    const native = integrityModule();
    if (native === null) {
      throw INTEGRITY_MODULE_MISSING();
    }
    try {
      return (await native.requestLocationPermission()) ?? 'none';
    } catch (error) {
      throw nativeFailure(error, 'The location permission request failed.');
    }
  }
}
