import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_PROTOCOL, PAIRING_TTL_MS, exportPublicJwk } from '@gian/remote-protocol';

import { enrollHost, makeRemoteTestApp, pairDevice, withControllerAccount } from './fixture.js';

test('QR nonce and short code claim the same grant; reuse and expiry fail', async () => {
  const { fetch: unauthenticatedFetch, clock, handle } = await makeRemoteTestApp();
  const fetch = await withControllerAccount(unauthenticatedFetch);
  const host = await enrollHost(fetch);
  const created = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string; grant_nonce: string };

  const byCode = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '11111111-1111-4111-8111-111111111111',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'iOS',
      user_agent: 'Mobile',
      code: created.code.toLowerCase(),
    }),
  });
  assert.equal(byCode.status, 200);

  const byNonce = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '22222222-2222-4222-8222-222222222222',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      grant_nonce: created.grant_nonce,
    }),
  });
  assert.equal(byNonce.status, 401);

  const expiredGrant = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  clock.tick(PAIRING_TTL_MS + 1);
  const expired = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '33333333-3333-4333-8333-333333333333',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: expiredGrant.code,
    }),
  });
  assert.equal(expired.status, 401);
  handle.shutdown();
});

test('pairing failure cap and reject prevent session issuance', async () => {
  const { fetch: unauthenticatedFetch, handle } = await makeRemoteTestApp();
  const fetch = await withControllerAccount(unauthenticatedFetch);
  const host = await enrollHost(fetch);
  const created = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const payload = {
    protocol: AUTH_PROTOCOL,
    browser_installation_id: '44444444-4444-4444-8444-444444444444',
    device_public_key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    },
    platform: 'macOS',
    user_agent: 'Desktop',
    code: created.code,
  };
  const first = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(first.status, 200);
  for (let index = 0; index < 5; index += 1) {
    const replay = await fetch('/api/v1/pairings/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        browser_installation_id: '55555555-5555-4555-8555-555555555555',
      }),
    });
    assert.equal(replay.status, 401);
  }
  const paired = await pairDevice(fetch, host.accessToken, host.hostId);
  const rejectGrant = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const pending = await (await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '66666666-6666-4666-8666-666666666666',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: rejectGrant.code,
    }),
  })).json() as { pairing_id: string };
  await fetch(`/api/v1/pairings/${pending.pairing_id}/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      pairing_id: pending.pairing_id,
      decision: 'reject',
    }),
  });
  const login = await fetch('/api/v1/sessions/device-challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '66666666-6666-4666-8666-666666666666',
      host_id: host.hostId,
    }),
  });
  assert.equal(login.status, 401);
  assert.ok(paired.accessToken);
  const again = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const reclaim = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: '66666666-6666-4666-8666-666666666666',
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: again.code,
    }),
  });
  assert.equal(reclaim.status, 200, 'reject must free (browser,host) for a new generation');
  handle.shutdown();
});

test('pairing claim race freezes the grant once', async () => {
  const { fetch: unauthenticatedFetch, handle } = await makeRemoteTestApp();
  const fetch = await withControllerAccount(unauthenticatedFetch);
  const host = await enrollHost(fetch);
  const created = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const claim = (browser: string) => fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: browser,
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: created.code,
    }),
  });
  const [first, second] = await Promise.all([
    claim('77777777-7777-4777-8777-777777777777'),
    claim('88888888-8888-4888-8888-888888888888'),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 401]);
  handle.shutdown();
});

test('a browser cannot claim its key again on a Host, and a key revoked on one Host still pairs with another', async () => {
  const { fetch: unauthenticatedFetch, clock, handle } = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1_000 } });
  const fetch = await withControllerAccount(unauthenticatedFetch);
  try {
    const repos = handle.services.repos;
    const hostX = await enrollHost(fetch);
    const hostY = await enrollHost(fetch);
    const onX = await pairDevice(fetch, hostX.accessToken, hostX.hostId);
    const onY = await pairDevice(fetch, hostY.accessToken, hostY.hostId, { keys: onX.keys, browserId: onX.browserId });
    const publicKey = await exportPublicJwk(onX.keys.publicKey);
    const json = (body: unknown, token?: string): RequestInit => ({
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const claimAgainOnX = async () => {
      const grant = await (await fetch('/api/v1/host/pairings', json({ protocol: AUTH_PROTOCOL }, hostX.accessToken)))
        .json() as { code: string };
      return (await fetch('/api/v1/pairings/claim', json({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: onX.browserId,
        device_public_key: publicKey,
        platform: 'macOS',
        user_agent: 'TestBrowser',
        code: grant.code,
      }))).status;
    };
    const challenge = async (hostId: string) => {
      const response = await fetch('/api/v1/sessions/device-challenge', json({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: onX.browserId,
        host_id: hostId,
      }));
      return response.status === 200 ? 200 : (await response.json() as { error: { code: string } }).error.code;
    };

    assert.equal(await claimAgainOnX(), 401, 'not while its pairing is active');
    assert.equal((await fetch(`/api/v1/host/devices/${onX.deviceId}/revoke`, json({ protocol: AUTH_PROTOCOL },
      hostX.accessToken))).status, 200);
    clock.tick(1_000);
    assert.equal(await claimAgainOnX(), 401, 'nor after the Host revoked it, even through a fresh grant');
    assert.equal(await challenge(hostX.hostId), 'DEVICE_REVOKED');

    // The revocation belongs to Host X.
    assert.equal(repos.isRevokedPublicKey(JSON.stringify(publicKey), hostX.hostId), true);
    assert.equal(repos.isRevokedPublicKey(JSON.stringify(publicKey), hostY.hostId), false);
    assert.equal(await challenge(hostY.hostId), 200);
    assert.equal((await fetch('/api/v1/ws-tickets', json({ protocol: AUTH_PROTOCOL, host_id: hostY.hostId },
      onY.accessToken))).status, 200);
    const hostZ = await enrollHost(fetch);
    const onZ = await pairDevice(fetch, hostZ.accessToken, hostZ.hostId, { keys: onX.keys, browserId: onX.browserId });
    assert.ok(onZ.deviceId);
    assert.ok(repos.keyAdmittedPairing(repos.getPairing(onZ.deviceId)));
  } finally { handle.shutdown(); }
});
