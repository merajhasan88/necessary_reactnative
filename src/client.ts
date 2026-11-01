/**
 * The public guide's five calls (section 4) over a [DeviceTrustTransport], the two scan calls each
 * with its request proof (section 3), and the app PIN's two calls.
 */

import { ApiException } from './errors';
import { currentPlatform } from './util/native';
import type { InstallationIdentity } from './installationKey';
import type { ReinstallHint } from './reinstallHint';
import { ScanChallenge, type SignedReport } from './report';
import { appPinProofRequest, RequestProof, signRequest } from './requestProof';
import type { StepUpKeyMetadata } from './stepUpKey';
import type { DeviceTrustTransport, JsonObject } from './transport';

export class DeviceTrustClient {
  /** The app PIN's default paths (the public guide, section 4). */
  static readonly appPinPath = '/v1/account/app-pin';
  static readonly appPinProofPath = '/v1/account/app-pin/proof';

  /** The fields of the guide's registration, which [registerInstallation]'s `extra` cannot replace. */
  static readonly registrationFields: ReadonlySet<string> = new Set([
    'installation_id',
    'platform',
    'public_key',
    'reinstall_hint',
    'key_security',
    'stepup_public_key',
    'stepup_key_auth',
  ]);

  readonly transport: DeviceTrustTransport;
  private readonly platform: () => string;

  /** [platform] replaces the phone's (`android` or `ios`) in tests. */
  constructor(transport: DeviceTrustTransport, options: { platform?: () => string } = {}) {
    this.transport = transport;
    this.platform = options.platform ?? currentPlatform;
  }

  /**
   * Sends [proof]'s request. [method], [path] and [encodedBody] replace what the proof was signed
   * for -- only to test that a backend refuses them.
   */
  sendSigned(proof: RequestProof, overrides: { method?: string; path?: string; encodedBody?: string } = {}): Promise<JsonObject> {
    const sentMethod = (overrides.method ?? proof.method).toUpperCase();
    return this.transport.send(sentMethod, overrides.path ?? proof.path, {
      bearerToken: proof.bearerToken,
      encodedBody: sentMethod === 'GET' ? null : overrides.encodedBody ?? proof.encodedBody,
      headers: proof.headers,
    });
  }

  /**
   * Signs and sends one request under [bearerToken], its [body] as JSON. [installationId] replaces
   * the installation the proof names, only to test that a backend refuses it.
   */
  async signAndSend(
    method: string,
    path: string,
    args: { bearerToken: string; identity: InstallationIdentity; body?: Record<string, unknown> | null; installationId?: string | null },
  ): Promise<JsonObject> {
    return this.sendSigned(
      await signRequest({
        identity: args.identity,
        method,
        path,
        bearerToken: args.bearerToken,
        encodedBody: JSON.stringify(args.body ?? {}),
        installationId: args.installationId,
      }),
    );
  }

  /**
   * Registers the installation's key, and with [stepUpKey] the step-up key. The answer's
   * `installation_id` is the installation your backend holds for this key, which may not be the one
   * proposed. [extra] adds fields of your backend's own.
   */
  registerInstallation(
    identity: InstallationIdentity,
    hint: ReinstallHint | null,
    options: { stepUpKey?: StepUpKeyMetadata | null; extra?: Record<string, unknown> } = {},
  ): Promise<JsonObject> {
    const extra = options.extra ?? {};
    const replaced = Object.keys(extra).filter((name) => DeviceTrustClient.registrationFields.has(name));
    if (replaced.length > 0) {
      throw new TypeError(`extra replaces the registration fields ${replaced.join(', ')}`);
    }
    const stepUpKey = options.stepUpKey ?? null;
    const body: Record<string, unknown> = {
      installation_id: identity.installationId,
      platform: this.platform() === 'android' ? 'android' : 'ios',
      public_key: identity.publicKeyJson,
      reinstall_hint: hint === null ? null : hint.toJSON(),
      // What the platform's keystore says about how the key is protected: a claim, not proof. Its
      // value is comparative -- a non-exportable hardware key cannot move into software, so the
      // same key later claiming a weaker level contradicts itself.
      key_security: {
        security_level: identity.securityLevel,
        hardware_backed: identity.hardwareBacked,
        provider: identity.provider,
      },
    };
    // The step-up key, and how the phone says it is unlocked: also a claim, recorded and compared
    // with what the backend requires.
    if (stepUpKey !== null) {
      body['stepup_public_key'] = stepUpKey.publicKey;
      body['stepup_key_auth'] = stepUpKey.authJson;
    }
    Object.assign(body, extra);
    return this.transport.send('POST', '/v1/installations/register', { encodedBody: JSON.stringify(body) });
  }

  /** Asks for a key challenge: `challenge_id` and the `payload` to sign. */
  createInstallationChallenge(installationId: string): Promise<JsonObject> {
    return this.transport.send('POST', '/v1/installations/challenge', {
      encodedBody: JSON.stringify({ installation_id: installationId }),
    });
  }

  /** Answers a key challenge; the answer carries `device_token`, your backend's session for this installation. */
  verifyInstallation(args: { installationId: string; challengeId: string; payload: string; signature: string }): Promise<JsonObject> {
    return this.transport.send('POST', '/v1/installations/verify', {
      encodedBody: JSON.stringify({
        installation_id: args.installationId,
        challenge_id: args.challengeId,
        payload: args.payload,
        signature: args.signature,
      }),
    });
  }

  /**
   * Asks for a scan under [session]: the installation's session, from [verifyInstallation] -- or,
   * for a scan that approves one [operation] ([describeOperation]), your account session for this
   * installation.
   */
  async integrityChallenge(args: {
    session: string;
    identity: InstallationIdentity;
    operation?: Record<string, unknown> | null;
  }): Promise<ScanChallenge> {
    const body: Record<string, unknown> = {};
    if (args.operation != null) {
      body['operation'] = args.operation;
    }
    return ScanChallenge.fromJson(
      await this.signAndSend('POST', '/v1/integrity/challenge', {
        bearerToken: args.session,
        identity: args.identity,
        body,
      }),
    );
  }

  /**
   * Sends [report] under the [session] that asked for its scan. The answer is your backend's own;
   * for a scan that approves one request it carries `report_id`, sent with that request as
   * `X-Integrity-Report`.
   */
  submitIntegrityReport(args: { session: string; identity: InstallationIdentity; report: SignedReport }): Promise<JsonObject> {
    return this.signAndSend('POST', '/v1/integrity/report', {
      bearerToken: args.session,
      identity: args.identity,
      body: args.report.toJSON(),
    });
  }

  /**
   * Sets the account's app PIN under its account [session]. The backend requires the person's own
   * re-authentication with it -- [reauthentication] carries it, the account's password for example:
   * `{password: ...}`.
   */
  setAppPin(args: {
    session: string;
    identity: InstallationIdentity;
    pin: string;
    reauthentication?: Record<string, unknown>;
    path?: string;
  }): Promise<JsonObject> {
    return this.signAndSend('POST', args.path ?? DeviceTrustClient.appPinPath, {
      bearerToken: args.session,
      identity: args.identity,
      body: { ...(args.reauthentication ?? {}), pin: args.pin },
    });
  }

  /**
   * Has the backend check the app [pin] for the one signed [request] -- sent once, in a signed body,
   * never in a header -- and answers that request unlocked by its proof, valid for that request
   * alone.
   */
  async proveAppPin(args: {
    session: string;
    identity: InstallationIdentity;
    pin: string;
    request: RequestProof;
    path?: string;
  }): Promise<RequestProof> {
    const answer = await this.signAndSend('POST', args.path ?? DeviceTrustClient.appPinProofPath, {
      bearerToken: args.session,
      identity: args.identity,
      body: appPinProofRequest({
        pin: args.pin,
        method: args.request.method,
        path: args.request.path,
        encodedBody: args.request.encodedBody,
        nonce: args.request.nonce,
      }),
    });
    const proof = answer['app_pin_proof'];
    if (typeof proof !== 'string' || proof.length === 0) {
      throw new ApiException('The backend answered no app PIN proof.', { code: 'app_pin_proof_missing' });
    }
    return args.request.withAppPinProof(proof);
  }

  close(): void {
    this.transport.close();
  }
}
