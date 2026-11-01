/** What the client does about the protocol errors of the public guide's section 4. */

import { ApiException } from './errors';

/**
 * What the client does about a refusal from your backend's API: the protocol errors of the
 * integration guide's section 4, each acted on once. Any other refusal goes to the app as it came.
 */
export enum ProtocolStep {
  askAgain = 'askAgain',
  proveAgain = 'proveAgain',
  registerAgain = 'registerAgain',
  waitThenRetry = 'waitThenRetry',
  stop = 'stop',
}

/** The longest wait the client sits through before it retries a 429 itself; a longer one goes to the app. */
export const protocolMaxWaitSeconds = 10;

/**
 * [deviceSession]: the request ran under the session from /v1/installations/verify, which the
 * client can renew by proving its key again; an account session is the app's to renew.
 */
export function protocolStepFor(error: ApiException, options: { deviceSession: boolean }): ProtocolStep {
  switch (error.code) {
    case 'challenge_expired':
    case 'challenge_used':
    case 'integrity_challenge_expired':
    case 'integrity_challenge_replay':
      return ProtocolStep.askAgain;
    case 'expired_token':
      return options.deviceSession ? ProtocolStep.proveAgain : ProtocolStep.stop;
    case 'installation_not_found':
      return ProtocolStep.registerAgain;
  }
  return protocolWait(error) === null ? ProtocolStep.stop : ProtocolStep.waitThenRetry;
}

/** How long a 429 asks the client to wait, in milliseconds, when that is short enough to wait. */
export function protocolWait(error: ApiException): number | null {
  const seconds = error.details?.['retry_after_seconds'];
  if (
    error.statusCode !== 429 ||
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > protocolMaxWaitSeconds
  ) {
    return null;
  }
  return Math.round(seconds * 1000);
}
