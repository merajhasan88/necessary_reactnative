/**
 * The installation key: one non-exportable P-256 key per installation, made and held by the
 * phone's keystore -- StrongBox or the trusted execution environment, the Secure Enclave, or
 * where that refuses the Keychain.
 */

import { NativeKeyException } from './errors';
import { sha256Hex } from './util/bytes';
import { installationKeyModule, isObject, nativeFailure } from './util/native';

/** A P-256 public key as a JWK: `kty`, `crv`, `alg`, `x`, `y`. */
export type PublicJwk = Record<string, unknown>;

/** The members of [jwk] in the order the phone writes them: kty, crv, alg, x, y, then any other. */
export function orderedJwk(jwk: Record<string, unknown>): PublicJwk {
  const ordered: PublicJwk = {};
  for (const name of ['kty', 'crv', 'alg', 'x', 'y']) {
    if (name in jwk) {
      ordered[name] = jwk[name];
    }
  }
  for (const [name, value] of Object.entries(jwk)) {
    if (!(name in ordered)) {
      ordered[name] = value;
    }
  }
  return ordered;
}

/** RFC 7638 thumbprint of an EC public JWK, in lowercase hex: the same form a backend derives. */
export function jwkThumbprint(jwk: PublicJwk): string {
  // RFC 7638 canonical member order for an EC public JWK.
  return sha256Hex(JSON.stringify({ crv: jwk['crv'], kty: 'EC', x: jwk['x'], y: jwk['y'] }));
}

export class NativeKeyMetadata {
  readonly publicKey: PublicJwk;
  readonly algorithm: string;
  readonly keyAlias: string;
  readonly provider: string;
  readonly securityLevel: string;
  readonly hardwareBacked: boolean;
  readonly privateKeyExportable: boolean;
  readonly signatureFormat: string;
  readonly created: boolean;

  constructor(value: {
    publicKey: PublicJwk;
    algorithm: string;
    keyAlias: string;
    provider: string;
    securityLevel: string;
    hardwareBacked: boolean;
    privateKeyExportable: boolean;
    signatureFormat: string;
    created: boolean;
  }) {
    this.publicKey = value.publicKey;
    this.algorithm = value.algorithm;
    this.keyAlias = value.keyAlias;
    this.provider = value.provider;
    this.securityLevel = value.securityLevel;
    this.hardwareBacked = value.hardwareBacked;
    this.privateKeyExportable = value.privateKeyExportable;
    this.signatureFormat = value.signatureFormat;
    this.created = value.created;
  }

  static fromPlatform(value: Record<string, unknown>): NativeKeyMetadata {
    const rawPublicKey = value['public_key'];
    if (!isObject(rawPublicKey)) {
      throw new TypeError('The native key provider returned no public key.');
    }
    const publicKey = orderedJwk(rawPublicKey);

    const requiredString = (field: string): string => {
      const item = value[field];
      if (typeof item !== 'string' || item.length === 0) {
        throw new TypeError(`The native key provider returned an invalid ${field}.`);
      }
      return item;
    };
    const requiredBool = (field: string): boolean => {
      const item = value[field];
      if (typeof item !== 'boolean') {
        throw new TypeError(`The native key provider returned an invalid ${field}.`);
      }
      return item;
    };

    if (
      publicKey['kty'] !== 'EC' ||
      publicKey['crv'] !== 'P-256' ||
      publicKey['alg'] !== 'ES256' ||
      typeof publicKey['x'] !== 'string' ||
      typeof publicKey['y'] !== 'string'
    ) {
      throw new TypeError('The native key provider did not return an EC P-256 public JWK.');
    }

    return new NativeKeyMetadata({
      publicKey,
      algorithm: requiredString('algorithm'),
      keyAlias: requiredString('key_alias'),
      provider: requiredString('provider'),
      securityLevel: requiredString('security_level'),
      hardwareBacked: requiredBool('hardware_backed'),
      privateKeyExportable: requiredBool('private_key_exportable'),
      signatureFormat: requiredString('signature_format'),
      created: requiredBool('created'),
    });
  }
}

const KEY_MODULE_MISSING = new NativeKeyException(
  'NATIVE_KEY_PLUGIN_MISSING',
  "The SDK's installation-key module is not linked into this app: rebuild the app.",
);

export class NativeInstallationKey {
  async getOrCreateKey(): Promise<NativeKeyMetadata> {
    const native = installationKeyModule();
    if (native === null) {
      throw KEY_MODULE_MISSING;
    }
    let value: unknown;
    try {
      value = await native.getOrCreateKey();
    } catch (error) {
      throw nativeFailure(error, 'The native key provider failed.');
    }
    if (!isObject(value)) {
      throw new NativeKeyException('EMPTY_NATIVE_RESPONSE', 'The native key provider returned no key metadata.');
    }
    return NativeKeyMetadata.fromPlatform(value);
  }

  async signPayload(payloadBase64Url: string): Promise<string> {
    const native = installationKeyModule();
    if (native === null) {
      throw KEY_MODULE_MISSING;
    }
    let signature: unknown;
    try {
      signature = await native.sign(payloadBase64Url);
    } catch (error) {
      throw nativeFailure(error, 'The native key provider could not sign the challenge.');
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw new NativeKeyException('EMPTY_NATIVE_SIGNATURE', 'The native key provider returned no signature.');
    }
    return signature;
  }

  async deleteKey(): Promise<void> {
    const native = installationKeyModule();
    if (native === null) {
      throw KEY_MODULE_MISSING;
    }
    try {
      await native.deleteKey();
    } catch (error) {
      throw nativeFailure(error, 'The native installation key could not be deleted.');
    }
  }
}

export class InstallationIdentity {
  readonly installationId: string;
  readonly nativeKey: NativeInstallationKey;
  readonly metadata: NativeKeyMetadata;

  constructor(value: { installationId: string; nativeKey: NativeInstallationKey; metadata: NativeKeyMetadata }) {
    this.installationId = value.installationId;
    this.nativeKey = value.nativeKey;
    this.metadata = value.metadata;
  }

  get publicKeyJson(): PublicJwk {
    return this.metadata.publicKey;
  }
  get algorithm(): string {
    return this.metadata.algorithm;
  }
  get keyAlias(): string {
    return this.metadata.keyAlias;
  }
  get provider(): string {
    return this.metadata.provider;
  }
  get securityLevel(): string {
    return this.metadata.securityLevel;
  }
  get hardwareBacked(): boolean {
    return this.metadata.hardwareBacked;
  }
  get privateKeyExportable(): boolean {
    return this.metadata.privateKeyExportable;
  }
  get signatureFormat(): string {
    return this.metadata.signatureFormat;
  }
  get createdThisLaunch(): boolean {
    return this.metadata.created;
  }

  /** The key's RFC 7638 thumbprint, in lowercase hex. */
  get keyThumbprint(): string {
    return jwkThumbprint(this.publicKeyJson);
  }

  signPayload(payloadBase64Url: string): Promise<string> {
    return this.nativeKey.signPayload(payloadBase64Url);
  }

  withInstallationId(canonicalInstallationId: string): InstallationIdentity {
    return new InstallationIdentity({
      installationId: canonicalInstallationId,
      nativeKey: this.nativeKey,
      metadata: this.metadata,
    });
  }
}
