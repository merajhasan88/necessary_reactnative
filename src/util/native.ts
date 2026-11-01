/**
 * The SDK's native modules, loaded when first used -- so that tests, which replace them, never
 * load React Native -- and their failures as [NativeKeyException]s.
 */

import { NativeKeyException } from '../errors';
import type { Spec as InstallationKeySpec } from '../native/NativeNecessaryInstallationKey';
import type { Spec as IntegritySpec } from '../native/NativeNecessaryIntegrity';
import type { Spec as SecureScreenSpec } from '../native/NativeNecessarySecureScreen';
import type { Spec as StepUpKeySpec } from '../native/NativeNecessaryStepUpKey';
import type { Spec as StorageSpec } from '../native/NativeNecessaryStorage';

/* eslint-disable @typescript-eslint/no-require-imports */
export function installationKeyModule(): InstallationKeySpec | null {
  return require('../native/NativeNecessaryInstallationKey').default ?? null;
}

export function integrityModule(): IntegritySpec | null {
  return require('../native/NativeNecessaryIntegrity').default ?? null;
}

export function stepUpKeyModule(): StepUpKeySpec | null {
  return require('../native/NativeNecessaryStepUpKey').default ?? null;
}

export function secureScreenModule(): SecureScreenSpec | null {
  return require('../native/NativeNecessarySecureScreen').default ?? null;
}

export function storageModule(): StorageSpec | null {
  return require('../native/NativeNecessaryStorage').default ?? null;
}

/** The phone's platform, as the guide names it: `android` or `ios`. */
export function currentPlatform(): string {
  return require('react-native').Platform.OS as string;
}
/* eslint-enable @typescript-eslint/no-require-imports */

/** A native module's refusal, with the code and the words it gave. */
export function nativeFailure(error: unknown, fallback: string): NativeKeyException {
  if (error instanceof NativeKeyException) {
    return error;
  }
  const failure = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const code = typeof failure.code === 'string' && failure.code.length > 0 ? failure.code : 'NATIVE_ERROR';
  const message = typeof failure.message === 'string' && failure.message.length > 0 ? failure.message : fallback;
  return new NativeKeyException(code, message);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
