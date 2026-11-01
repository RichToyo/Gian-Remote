import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTH_PROTOCOL,
  RemoteProtocolError,
  bytesToBase64Url,
  discoverServerIdentity,
  verifyServerIdentityProof,
} from '@gian/remote-protocol';
import { makeRemoteTestApp } from './fixture.js';

function fetchPath(fetchImpl: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return fetchImpl(new URL(url).pathname, init);
  }) as typeof fetch;
}

test('server identity proof binds the caller nonce and a replaced fingerprint is rejected', async () => {
  const f = await makeRemoteTestApp();
  try {
    const nonce = bytesToBase64Url(new Uint8Array(32));
    const response = await f.fetch('/api/v1/server-identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, nonce }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const proof = await response.json() as { nonce?: string; expires_at: number; server_identity: { fingerprint: string } };
    assert.equal(proof.nonce, undefined);
    assert.equal(proof.expires_at, f.clock.now + 120_000);
    assert.equal(proof.server_identity.fingerprint, f.handle.services.identity.fingerprint);
    const verified = await verifyServerIdentityProof({ nonce, proof, now: f.clock.now });
    assert.equal(verified.firstUse, true);
    let pin = verified.fingerprint;
    await assert.rejects(
      () => verifyServerIdentityProof({ nonce, proof, now: f.clock.now, pinnedFingerprint: 'b'.repeat(64) }),
      (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity changed',
    );
    assert.equal(pin, verified.fingerprint);
    const discovered = await discoverServerIdentity({
      origin: f.publicOrigin,
      fetchFn: fetchPath(f.fetch),
      now: () => f.clock.now,
      pinnedFingerprint: pin,
    });
    assert.equal(discovered.fingerprint, pin);
    assert.equal(discovered.firstUse, false);
    const rejected = await f.fetch('/api/v1/server-identity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, nonce, extra: true }),
    });
    assert.equal(rejected.status, 400);
  } finally { f.handle.shutdown(); }
});

test('server identity discovery counts toward the auth rate limit', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1 } });
  try {
    const fetchFn = fetchPath(f.fetch);
    await discoverServerIdentity({ origin: f.publicOrigin, fetchFn, now: () => f.clock.now });
    await assert.rejects(
      () => discoverServerIdentity({ origin: f.publicOrigin, fetchFn, now: () => f.clock.now }),
      (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity proof rejected',
    );
  } finally { f.handle.shutdown(); }
});
