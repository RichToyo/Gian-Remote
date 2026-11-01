import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  AUTH_PROTOCOL,
  RemoteProtocolError,
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  serverIdentityProofPayload,
  signBytes,
} from '@gian/remote-protocol';
import { pinDiscoveredServer, readServerIdentityPin, SERVER_PIN_KEY } from '../src/transport/server-pin.js';

beforeEach(() => localStorage.clear());

async function proofFetch(fingerprint: string, keys: CryptoKeyPair): Promise<typeof fetch> {
  const publicKey = await exportPublicJwk(keys.publicKey);
  return async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-gian-account-token')).toBeNull();
    const body = JSON.parse(String(init?.body)) as { protocol: string; nonce: string };
    expect(body.protocol).toBe(AUTH_PROTOCOL);
    const expiresAt = Date.now() + 60_000;
    const payload = serverIdentityProofPayload({
      nonce: body.nonce, fingerprint, expires_at: expiresAt,
    });
    return Response.json({
      protocol: AUTH_PROTOCOL,
      server_identity: { algorithm: 'P-256', public_key: publicKey, fingerprint },
      expires_at: expiresAt,
      signature: await signBytes(keys.privateKey, new TextEncoder().encode(payload)),
    });
  };
}

describe('browser server identity pin', () => {
  it('saves the first proof and keeps that pin when a later key is presented', async () => {
    const firstKeys = await generateP256SigningKeyPair();
    const firstFingerprint = await identityFingerprint(await exportPublicJwk(firstKeys.publicKey));
    const saved = await pinDiscoveredServer({
      origin: 'https://remote.test',
      fetchFn: await proofFetch(firstFingerprint, firstKeys),
    });
    expect(saved).toBe(firstFingerprint);
    expect(readServerIdentityPin()).toBe(firstFingerprint);
    expect(localStorage.getItem(SERVER_PIN_KEY)).toBe(firstFingerprint);

    const secondKeys = await generateP256SigningKeyPair();
    const secondFingerprint = await identityFingerprint(await exportPublicJwk(secondKeys.publicKey));
    await expect(pinDiscoveredServer({
      origin: 'https://remote.test',
      fetchFn: await proofFetch(secondFingerprint, secondKeys),
    })).rejects.toMatchObject({ message: 'server identity changed' });
    expect(readServerIdentityPin()).toBe(firstFingerprint);
    const error = await pinDiscoveredServer({
      origin: 'https://remote.test',
      fetchFn: await proofFetch(secondFingerprint, secondKeys),
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(RemoteProtocolError);
    expect(localStorage.getItem(SERVER_PIN_KEY)).toBe(firstFingerprint);
  });

  it('isolates Desktop pins A -> B -> A and still rejects a changed identity on the same Server', async () => {
    const a = 'https://a.remote.test', b = 'https://b.remote.test';
    const aKeys = await generateP256SigningKeyPair();
    const bKeys = await generateP256SigningKeyPair();
    const changedKeys = await generateP256SigningKeyPair();
    const aFingerprint = await identityFingerprint(await exportPublicJwk(aKeys.publicKey));
    const bFingerprint = await identityFingerprint(await exportPublicJwk(bKeys.publicKey));
    const changedFingerprint = await identityFingerprint(await exportPublicJwk(changedKeys.publicKey));
    await pinDiscoveredServer({ origin: a, storageScope: a, fetchFn: await proofFetch(aFingerprint, aKeys) });
    await pinDiscoveredServer({ origin: b, storageScope: b, fetchFn: await proofFetch(bFingerprint, bKeys) });
    expect(readServerIdentityPin(a)).toBe(aFingerprint);
    expect(readServerIdentityPin(b)).toBe(bFingerprint);
    await expect(pinDiscoveredServer({ origin: a, storageScope: a,
      fetchFn: await proofFetch(changedFingerprint, changedKeys) })).rejects.toMatchObject({ message: 'server identity changed' });
    expect(readServerIdentityPin(a)).toBe(aFingerprint);
    expect(readServerIdentityPin(b)).toBe(bFingerprint);
    expect(localStorage.getItem(SERVER_PIN_KEY)).toBeNull();
  });

  it('fails closed for an unassigned legacy pin and for storage write failures', async () => {
    const a = 'https://a.remote.test', b = 'https://b.remote.test';
    localStorage.setItem(SERVER_PIN_KEY, 'a'.repeat(64));
    expect(() => readServerIdentityPin(b)).toThrow('server identity pin scope is unassigned');
    expect(localStorage.getItem(SERVER_PIN_KEY)).toBe('a'.repeat(64));
    localStorage.removeItem(SERVER_PIN_KEY);
    const keys = await generateP256SigningKeyPair();
    const fingerprint = await identityFingerprint(await exportPublicJwk(keys.publicKey));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    try {
      await expect(pinDiscoveredServer({ origin: a, storageScope: a,
        fetchFn: await proofFetch(fingerprint, keys) })).rejects.toThrow('blocked');
      expect(readServerIdentityPin(a)).toBeNull();
    } finally { write.mockRestore(); }
  });
});
