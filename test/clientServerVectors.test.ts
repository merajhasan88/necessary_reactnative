// The shared client-server vectors, vectors/client_server.json: the SDK must produce, byte for byte,
// the request proof it signs, the operation a scan names, its key's thumbprint, the step-up proofs
// and the app PIN's request -- the integration guide's sections 1 to 3. A backend can test itself
// against the same file.
import {
  appPinProofRequest,
  describeOperation,
  InstallationIdentity,
  NativeInstallationKey,
  NativeKeyMetadata,
  signRequest,
  stepUpProof,
  stepUpReenrolProof,
} from '../src';
import { base64UrlDecode, utf8Decode } from '../src/util/bytes';
import { readJson } from './support/repositoryFiles';

/** Signs nothing: the vectors fix what is signed, and ECDSA signatures are randomized, so the signature is the backend's own check. */
class VectorKey extends NativeInstallationKey {
  override async getOrCreateKey(): Promise<NativeKeyMetadata> {
    throw new Error('unimplemented');
  }
  override async signPayload(): Promise<string> {
    return 'unsigned';
  }
  override async deleteKey(): Promise<void> {}
}

function identity(installationId: string, jwk: Record<string, unknown>): InstallationIdentity {
  return new InstallationIdentity({
    installationId,
    nativeKey: new VectorKey(),
    metadata: new NativeKeyMetadata({
      publicKey: jwk,
      algorithm: 'ES256',
      keyAlias: 'vector',
      provider: 'vector',
      securityLevel: 'software',
      hardwareBacked: false,
      privateKeyExportable: false,
      signatureFormat: 'der',
      created: false,
    }),
  });
}

const unpadded = (value: string): Uint8Array => base64UrlDecode(value);

const vectors = readJson('vectors/client_server.json');
const someKey = vectors['thumbprint'][0]['jwk'];

describe('access proof', () => {
  for (const vector of vectors['access_proof']) {
    test(vector['name'], async () => {
      const body = vector['body'];
      const proof = await signRequest({
        identity: identity(vector['installation_id'], someKey),
        method: vector['method'],
        path: vector['path'],
        bearerToken: vector['bearer'],
        encodedBody: body === null ? '' : JSON.stringify(body),
        timestamp: vector['timestamp'],
        nonce: unpadded(vector['nonce']),
      });
      expect(proof.encodedBody).toBe(vector['sent_body']); // the body sent
      expect(utf8Decode(unpadded(proof.payload))).toBe(vector['proof_json']); // the proof, as JSON
      expect(proof.payload).toBe(vector['proof']); // the proof, as sent
    });
  }
});

describe('operation a scan names', () => {
  for (const vector of vectors['operation']) {
    test(vector['name'], () => {
      expect(JSON.stringify(vector['body'])).toBe(vector['sent_body']); // the body sent
      expect(describeOperation(vector['method'], vector['path'], JSON.stringify(vector['body']))).toEqual(
        vector['operation'],
      );
    });
  }
});

describe('key thumbprint', () => {
  for (const vector of vectors['thumbprint']) {
    test(vector['name'], () => {
      expect(identity('00000000-0000-4000-8000-000000000000', vector['jwk']).keyThumbprint).toBe(vector['thumbprint']);
    });
  }
});

// The step-up proofs (the public guide, section 3): what the step-up key signs for one request, and
// what a new step-up key signs at re-enrolment.
describe('step-up proof v2', () => {
  for (const vector of vectors['step_up_proof']) {
    test(vector['name'], () => {
      const sent = JSON.stringify(vector['body']);
      expect(sent).toBe(vector['sent_body']); // the body sent
      const payload = stepUpProof({
        installationId: vector['installation_id'],
        accessToken: vector['bearer'],
        method: 'POST',
        path: vector['path'],
        encodedBody: sent,
        factor: vector['factor'],
        nonce: vector['nonce'],
        timestamp: vector['timestamp'],
      });
      expect(utf8Decode(unpadded(payload))).toBe(vector['proof_json']); // the proof, as JSON
      expect(payload).toBe(vector['proof']); // the proof, as sent
    });
  }
});

describe('step-up key re-enrolment proof', () => {
  for (const vector of vectors['step_up_reenrol_proof']) {
    test(vector['name'], () => {
      const payload = stepUpReenrolProof({
        installationId: vector['installation_id'],
        stepUpKeyThumbprint: vector['stepup_key_thumbprint'],
        nonce: vector['nonce'],
        timestamp: vector['timestamp'],
      });
      expect(utf8Decode(unpadded(payload))).toBe(vector['proof_json']); // the proof, as JSON
      expect(payload).toBe(vector['proof']); // the proof, as sent
    });
  }
});

// What the app sends to have its backend check the app PIN for one request (the public guide,
// section 3).
describe('app PIN proof request', () => {
  for (const vector of vectors['app_pin_proof_request']) {
    test(vector['name'], () => {
      const sent = JSON.stringify(vector['body']);
      expect(sent).toBe(vector['sent_body']); // the body of the request it unlocks
      expect(
        JSON.stringify(
          appPinProofRequest({
            pin: vector['pin'],
            method: 'POST',
            path: vector['path'],
            encodedBody: sent,
            nonce: vector['nonce'],
          }),
        ),
      ).toBe(vector['asked_body']);
    });
  }
});
