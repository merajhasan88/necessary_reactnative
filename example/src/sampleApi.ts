// The sample backend's own API (../backend/README.md): how an app signs what it sends to its own
// backend -- a request proof on every request, and the person's approval on a sensitive one -- and
// requests made wrong on purpose, which a backend must refuse.
import { ApiException, signRequest, type DeviceTrust, type JsonObject, type RequestProof } from '@necessarysdk/react-native';

const ECHO = '/v1/demo/echo';
const SENSITIVE = '/v1/demo/sensitive';
const ECHO_BODY = '{"hello":"backend"}';
const PAYEE_BODY = '{"payee":"payee-7"}';

export class SampleApi {
  readonly trust: DeviceTrust;

  /** The sample's account session for this installation, after [signIn]. */
  account: string | null = null;

  constructor(trust: DeviceTrust) {
    this.trust = trust;
  }

  private get session(): string {
    if (this.account === null) {
      throw new Error('Sign in first.');
    }
    return this.account;
  }

  /**
   * The sample's sign-in, under the installation session from start(): an account session for this
   * installation. The sample makes the account at its first sign-in.
   */
  async signIn(handle: string, password: string): Promise<void> {
    const proof = await this.trust.signRequest({
      method: 'POST',
      path: '/v1/demo/sign-in',
      bearer: this.trust.installationSession as string,
      body: JSON.stringify({ handle, password }),
    });
    this.account = (await this.trust.send(proof))['account_session'] as string;
  }

  /** A request with its request proof alone: only this installation's key can sign it, so the session is useless on another phone. */
  async protectedRequest(): Promise<JsonObject> {
    return this.trust.send(
      await this.trust.signRequest({ method: 'POST', path: ECHO, bearer: this.session, body: ECHO_BODY }),
    );
  }

  /**
   * The sensitive request. With [stepUp] the person approves it with the screen lock -- the phone
   * asks, showing the reason; with [appPin] the backend checks the PIN for this request first. With
   * neither the backend refuses it.
   */
  async sensitive(options: { stepUp?: boolean; appPin?: string | null } = {}): Promise<JsonObject> {
    return this.trust.send(
      await this.trust.signRequest({
        method: 'POST',
        path: SENSITIVE,
        bearer: this.session,
        body: PAYEE_BODY,
        stepUp: options.stepUp ?? false,
        reason: 'Approve the new payee',
        appPin: options.appPin ?? null,
      }),
    );
  }

  /** A new step-up key, with the person's password: after the screen lock was removed, say, when approvals fail with STEPUP_KEY_INVALIDATED. */
  reenrolStepUp(password: string): Promise<JsonObject> {
    return this.trust.reenrolStepUp({ session: this.session, reauthentication: { password } });
  }

  /** Sets the account's app PIN, with the person's password. */
  setAppPin(pin: string, password: string): Promise<JsonObject> {
    return this.trust.setAppPin({ session: this.session, pin, reauthentication: { password } });
  }

  // --- Requests a backend must refuse.

  private signedEcho(): Promise<RequestProof> {
    return this.trust.signRequest({ method: 'POST', path: ECHO, bearer: this.session, body: ECHO_BODY });
  }

  /** One signed request sent twice: the second is a replay. */
  async replay(): Promise<JsonObject> {
    const proof = await this.signedEcho();
    try {
      await this.trust.send(proof);
    } catch (error) {
      if (error instanceof ApiException) {
        // The first must go through, or the second tests nothing.
        throw new Error(`The first send was refused: ${error.statusCode} ${error.code}.`);
      }
      throw error;
    }
    return this.trust.send(proof);
  }

  /** A signed request whose body is changed on the way. */
  async changedBody(): Promise<JsonObject> {
    return this.trust.client.sendSigned(await this.signedEcho(), { encodedBody: '{"hello":"changed"}' });
  }

  /** A signed request sent to another path. */
  async otherPath(): Promise<JsonObject> {
    return this.trust.client.sendSigned(await this.signedEcho(), { path: SENSITIVE });
  }

  /** A request proof signed ten minutes ago. */
  async staleProof(): Promise<JsonObject> {
    return this.trust.send(
      await signRequest({
        identity: await this.trust.loadIdentity(),
        method: 'POST',
        path: ECHO,
        bearerToken: this.session,
        encodedBody: ECHO_BODY,
        timestamp: Math.floor(Date.now() / 1000) - 600,
      }),
    );
  }

  /** This phone's account session and installation, to try on another phone. */
  shareSession(): string {
    return JSON.stringify({ session: this.session, installation_id: this.trust.identity?.installationId });
  }

  /** A session [shared] from another phone, used here: this phone's key signs a request naming that phone's installation. */
  async sessionFromAnotherPhone(shared: string): Promise<JsonObject> {
    const copied = JSON.parse(shared.trim()) as Record<string, string>;
    return this.trust.send(
      await signRequest({
        identity: await this.trust.loadIdentity(),
        method: 'POST',
        path: ECHO,
        bearerToken: copied['session'],
        encodedBody: ECHO_BODY,
        installationId: copied['installation_id'],
      }),
    );
  }
}
