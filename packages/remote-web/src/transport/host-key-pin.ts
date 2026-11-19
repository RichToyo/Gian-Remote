import { RemoteProtocolError } from '@gian/remote-protocol';

/**
 * Trust-on-first-use pin of each computer's end-to-end encryption key.
 *
 * Device login returns the Host's public key from the Remote Server. Without
 * a pin, anyone able to change that record on the Server could put their own
 * key in the middle of every session. The first key this browser sees for a
 * Host is stored with this browser's key for that Host (so it is cleared
 * together with the pairing); a different one later ends the pairing, and
 * pairing again — which the owner confirms on the computer — is the only way
 * to accept it.
 */
export class HostKeyChangedError extends RemoteProtocolError {
  constructor(hostId: string) {
    super('DEVICE_NOT_PAIRED', `the encryption key of Host ${hostId} changed`);
    this.name = 'HostKeyChangedError';
  }
}

export function hostKeyFingerprint(jwk: { crv: string; x: string; y: string }): string {
  return `${jwk.crv}:${jwk.x}:${jwk.y}`;
}
