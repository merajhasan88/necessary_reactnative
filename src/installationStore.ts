/**
 * Where the SDK keeps the installation ID: in the platform's secure storage beside the key -- on
 * iOS in the Keychain, on this device only, readable after the first unlock; elsewhere encrypted
 * under a key the platform keystore holds.
 */

import { NativeKeyException } from './errors';
import { nativeFailure, storageModule } from './util/native';
import { secureRandomBytes } from './requestProof';
import { InstallationIdentity, NativeInstallationKey } from './installationKey';

/** The secure storage the store writes to: replaced in tests. */
export interface SecureStorage {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const STORAGE_MODULE_MISSING = (): NativeKeyException =>
  new NativeKeyException(
    'NATIVE_STORAGE_PLUGIN_MISSING',
    "The SDK's storage module is not linked into this app: rebuild the app.",
  );

/** The phone's secure storage, through the SDK's native module. */
export class NativeSecureStorage implements SecureStorage {
  async read(key: string): Promise<string | null> {
    const native = storageModule();
    if (native === null) throw STORAGE_MODULE_MISSING();
    try {
      const value = await native.read(key);
      return typeof value === 'string' ? value : null;
    } catch (error) {
      throw nativeFailure(error, 'The secure storage could not be read.');
    }
  }

  async write(key: string, value: string): Promise<void> {
    const native = storageModule();
    if (native === null) throw STORAGE_MODULE_MISSING();
    try {
      await native.write(key, value);
    } catch (error) {
      throw nativeFailure(error, 'The secure storage could not be written.');
    }
  }

  async delete(key: string): Promise<void> {
    const native = storageModule();
    if (native === null) throw STORAGE_MODULE_MISSING();
    try {
      await native.remove(key);
    } catch (error) {
      throw nativeFailure(error, 'The secure storage could not be cleared.');
    }
  }
}

/** A random (version 4) UUID, from the platform's secure random source. */
export async function randomUuid(): Promise<string> {
  const bytes = await secureRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexBytes = Array.from(bytes, (byte) => (byte < 16 ? '0' : '') + byte.toString(16));
  return [
    hexBytes.slice(0, 4).join(''),
    hexBytes.slice(4, 6).join(''),
    hexBytes.slice(6, 8).join(''),
    hexBytes.slice(8, 10).join(''),
    hexBytes.slice(10, 16).join(''),
  ].join('-');
}

export class InstallationStore {
  static readonly installationIdKey = 'recognition.installation_id.v2';
  static readonly stepUpReenrolKey = 'recognition.stepup_reenrol_pending.v1';

  readonly key: NativeInstallationKey;
  protected readonly storage: SecureStorage;
  private loading: Promise<InstallationIdentity> | null = null;

  constructor(options: { key?: NativeInstallationKey; storage?: SecureStorage } = {}) {
    this.key = options.key ?? new NativeInstallationKey();
    this.storage = options.storage ?? new NativeSecureStorage();
  }

  /**
   * The installation: its key, made on first use, and its ID. A key made now
   * ([InstallationIdentity.createdThisLaunch]) is a new installation, so it gets a new ID even where
   * one was stored: that ID belongs to the key that was lost, and a backend refuses a known ID under
   * another key. Calls at once share one load, so that one key never gets two IDs.
   */
  loadOrCreate(): Promise<InstallationIdentity> {
    const running = this.loading;
    if (running !== null) {
      return running;
    }
    const loading: Promise<InstallationIdentity> = this.load().finally(() => {
      if (this.loading === loading) {
        this.loading = null;
      }
    });
    this.loading = loading;
    return loading;
  }

  private async load(): Promise<InstallationIdentity> {
    const stored = await this.storage.read(InstallationStore.installationIdKey);
    const metadata = await this.key.getOrCreateKey();
    let installationId = stored ?? '';
    if (installationId.length === 0 || metadata.created) {
      installationId = await randomUuid();
      await this.saveInstallationId(installationId);
    }
    return new InstallationIdentity({ installationId, nativeKey: this.key, metadata });
  }

  /**
   * Keeps the installation your backend answered for this key, which may not be the ID proposed.
   * Only this opaque ID is stored here; the private key never leaves the platform's keystore.
   */
  saveInstallationId(installationId: string): Promise<void> {
    return this.storage.write(InstallationStore.installationIdKey, installationId);
  }

  /** Whether a step-up key was replaced and the backend has not yet taken the new one (DeviceTrust.reenrolStepUp) -- kept across restarts. */
  async stepUpReenrolPending(): Promise<boolean> {
    return (await this.storage.read(InstallationStore.stepUpReenrolKey)) !== null;
  }

  setStepUpReenrolPending(pending: boolean): Promise<void> {
    return pending
      ? this.storage.write(InstallationStore.stepUpReenrolKey, '1')
      : this.storage.delete(InstallationStore.stepUpReenrolKey);
  }

  /** Deletes the key and the installation ID: the next start is a new installation. */
  async clear(): Promise<void> {
    await this.key.deleteKey();
    await this.storage.delete(InstallationStore.installationIdKey);
    await this.storage.delete(InstallationStore.stepUpReenrolKey);
  }
}
