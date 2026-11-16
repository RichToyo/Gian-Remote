import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AUTH_PROTOCOL, generateCanonicalId } from '@gian/remote-protocol';

import { hashEnrollmentPassword } from '../src/auth/enrollment-password.js';
import { SlidingWindowLimiter } from '../src/auth/rate-limit.js';
import { enrollHost, listenRemoteApp, makeRemoteTestApp, pairDevice, withControllerAccount } from './fixture.js';

test('auth rate limit and per-host device cap isolate abuse', async () => {
  const { fetch: unauthenticatedFetch, handle } = await makeRemoteTestApp({
    config: { authRateLimitPerMinute: 3, maxDevicesPerHost: 1 },
  });
  const fetch = await withControllerAccount(unauthenticatedFetch);
  const host = await enrollHost(fetch);
  await pairDevice(fetch, host.accessToken, host.hostId);
  const second = await (await fetch('/api/v1/host/pairings', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${host.accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { code: string };
  const overflow = await fetch('/api/v1/pairings/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: generateCanonicalId(),
      device_public_key: {
        kty: 'EC',
        crv: 'P-256',
        x: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        y: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      },
      platform: 'macOS',
      user_agent: 'Desktop',
      code: second.code,
    }),
  });
  assert.equal(overflow.status, 429);

  const limited = [];
  for (let index = 0; index < 4; index += 1) {
    limited.push(await fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    }));
  }
  const throttled = limited.find((response) => response.status === 429);
  assert.ok(throttled);
  assert.equal(throttled.headers.get('retry-after'), '60');
  handle.shutdown();
});

type TestApp = Awaited<ReturnType<typeof makeRemoteTestApp>>;

/** POST as one client: `address` is the socket peer @hono/node-server reports. */
function clientPost(f: TestApp, address: string, headers: Record<string, string> = {}) {
  return (path: string, body: object = { protocol: AUTH_PROTOCOL }) => f.handle.app.fetch(new Request(`https://remote.test${path}`, {
    method: 'POST',
    headers: { origin: f.publicOrigin, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }), { incoming: { socket: { remoteAddress: address } } });
}

test('clients at different socket addresses never share a rate limit bucket', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1 } });
  try {
    const first = clientPost(f, '203.0.113.1');
    assert.notEqual((await first('/api/v1/account/logout')).status, 429);
    const limited = await first('/api/v1/account/logout');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(await limited.json(), {
      protocol: AUTH_PROTOCOL, error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED' },
    });
    // The IPv4-mapped IPv6 form is the same client.
    assert.equal((await clientPost(f, '::ffff:203.0.113.1')('/api/v1/account/logout')).status, 429);
    // Without a trusted proxy a forwarded header is ignored.
    assert.equal((await clientPost(f, '203.0.113.1', { 'x-forwarded-for': '198.51.100.9' })('/api/v1/account/logout')).status, 429);
    assert.notEqual((await clientPost(f, '203.0.113.2')('/api/v1/account/logout')).status, 429);
    assert.notEqual((await clientPost(f, '2001:db8::2')('/api/v1/account/logout')).status, 429);
  } finally { f.handle.shutdown(); }
});

test('a listening server keys on the real socket peer', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1 } });
  const listened = await listenRemoteApp(f.handle);
  try {
    const overSocket = () => fetch(`${listened.url}/api/v1/account/logout`, {
      method: 'POST',
      headers: { origin: f.publicOrigin, 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    });
    assert.notEqual((await overSocket()).status, 429);
    assert.equal((await overSocket()).status, 429);
    // The loopback client's bucket is not the one of a request without a socket.
    assert.notEqual((await f.fetch('/api/v1/account/logout', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).status, 429);
  } finally { listened.close(); }
});

test('behind a trusted proxy only the proxy-appended forwarded address keys the bucket', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1, trustedProxy: true } });
  try {
    const viaProxy = (forwarded: string) => clientPost(f, '127.0.0.1', { 'x-forwarded-for': forwarded })('/api/v1/account/logout');
    assert.notEqual((await viaProxy('10.0.0.1, 198.51.100.7')).status, 429);
    // A client rewriting the entries left of the proxy's is still the same client.
    assert.equal((await viaProxy('10.0.0.2, 198.51.100.7')).status, 429);
    assert.equal((await viaProxy('198.51.100.8, 198.51.100.7')).status, 429);
    assert.notEqual((await viaProxy('10.0.0.1, 198.51.100.8')).status, 429);
    assert.notEqual((await viaProxy('[2001:db8::7]:4431')).status, 429);
    assert.equal((await viaProxy('2001:db8::7')).status, 429);
    // A missing or unusable header falls back to the socket peer.
    assert.notEqual((await viaProxy('not-an-address')).status, 429);
    assert.equal((await clientPost(f, '127.0.0.1')('/api/v1/account/logout')).status, 429);
  } finally { f.handle.shutdown(); }
});

test('identity routes limit each identity, and each address more loosely', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 2 } });
  try {
    const challenge = (address: string, hostId: string) => clientPost(f, address)('/api/v1/host/connector-challenge',
      { protocol: AUTH_PROTOCOL, host_id: hostId });
    const busy = generateCanonicalId();
    const other = generateCanonicalId();
    for (let index = 0; index < 2; index += 1) assert.notEqual((await challenge('203.0.113.1', busy)).status, 429);
    assert.equal((await challenge('203.0.113.1', busy)).status, 429);
    // The busy Host locks out neither another Host at its address nor anyone elsewhere.
    assert.notEqual((await challenge('203.0.113.1', other)).status, 429);
    assert.notEqual((await challenge('203.0.113.2', other)).status, 429);
    // The identity bucket follows the identity across addresses.
    assert.equal((await challenge('203.0.113.3', busy)).status, 429);

    // Rotating identities from one address meets the per-address bucket (6x).
    for (let index = 0; index < 12; index += 1) {
      assert.notEqual((await challenge('203.0.113.4', generateCanonicalId())).status, 429);
    }
    assert.equal((await challenge('203.0.113.4', generateCanonicalId())).status, 429);
    assert.notEqual((await challenge('203.0.113.5', generateCanonicalId())).status, 429);

    // A request naming no identity keeps the strict per-address limit.
    const anonymous = clientPost(f, '203.0.113.6');
    for (let index = 0; index < 2; index += 1) assert.notEqual((await anonymous('/api/v1/sessions/refresh')).status, 429);
    assert.equal((await anonymous('/api/v1/sessions/refresh')).status, 429);
  } finally { f.handle.shutdown(); }
});

test('the server identity proof every client asks for allows six times the limit per address, and claims stay as strict', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 2 } });
  try {
    // Live: one Gian's reconnects used up a household's address and locked out its next pairing.
    const household = clientPost(f, '203.0.113.1');
    for (let index = 0; index < 12; index += 1) assert.notEqual((await household('/api/v1/server-identity')).status, 429);
    const limited = await household('/api/v1/server-identity');
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get('retry-after'), '60');
    assert.deepEqual(await limited.json(), {
      protocol: AUTH_PROTOCOL, error: { code: 'RATE_LIMITED', message: 'RATE_LIMITED' },
    });
    // Every other address has its own bucket, and no global cap fills up.
    for (let address = 2; address <= 5; address += 1) {
      const neighbour = clientPost(f, `203.0.113.${address}`);
      for (let index = 0; index < 12; index += 1) assert.notEqual((await neighbour('/api/v1/server-identity')).status, 429);
    }

    // Pairing and enrollment claims (guessable codes and tokens) and the other
    // address routes keep the strict per-address limit at that same address.
    for (const path of ['/api/v1/pairings/claim', '/api/v1/host-enrollments/claim', '/api/v1/controller-enrollments/claim',
      '/api/v1/account/start']) {
      for (let index = 0; index < 2; index += 1) assert.notEqual((await household(path)).status, 429, path);
      const strict = await household(path);
      assert.equal(strict.status, 429, path);
      assert.equal(strict.headers.get('retry-after'), '60', path);
    }
    f.clock.tick(60_001);
    assert.notEqual((await household('/api/v1/server-identity')).status, 429);
  } finally { f.handle.shutdown(); }
});

test('guarded routes stay limited per address plus one global cap', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1 } });
  try {
    const claim = (address: string) => clientPost(f, address)('/api/v1/pairings/claim', {
      protocol: AUTH_PROTOCOL, browser_installation_id: generateCanonicalId(), code: 'ABCD-EFGH',
    });
    assert.notEqual((await claim('203.0.113.1')).status, 429);
    // A fresh identity in the body does not buy another attempt.
    assert.equal((await claim('203.0.113.1')).status, 429);
    for (let index = 2; index <= 10; index += 1) assert.notEqual((await claim(`203.0.113.${index}`)).status, 429);
    // Ten per-address limits used across addresses exhaust the global cap.
    const capped = await claim('203.0.113.11');
    assert.equal(capped.status, 429);
    assert.equal(capped.headers.get('retry-after'), '60');
    assert.equal((await capped.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
    f.clock.tick(60_001);
    assert.notEqual((await claim('203.0.113.11')).status, 429);
  } finally { f.handle.shutdown(); }
});

test('enrollment password failures are limited per address and globally', async () => {
  const f = await makeRemoteTestApp({ config: { enrollmentPasswordHash: await hashEnrollmentPassword('page-secret') } });
  try {
    // A missing CSRF header is a failed attempt and skips the scrypt check.
    const fail = (address: string) => clientPost(f, address)('/api/v1/enrollment/login',
      { protocol: AUTH_PROTOCOL, password: 'guess' });
    for (let index = 0; index < 5; index += 1) assert.equal((await fail('203.0.113.1')).status, 403);
    assert.equal((await fail('203.0.113.1')).status, 429);
    assert.equal((await fail('203.0.113.2')).status, 403);
    for (let address = 3; address <= 5; address += 1) {
      for (let index = 0; index < 5; index += 1) await fail(`203.0.113.${address}`);
    }
    // 20 failures from any addresses close the page for 15 minutes.
    assert.equal((await fail('203.0.113.6')).status, 429);
    f.clock.tick(15 * 60 * 1000 + 1);
    assert.equal((await fail('203.0.113.6')).status, 403);
  } finally { f.handle.shutdown(); }
});

test('rate limiter drops keys once their hits leave the window', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 2 } });
  try {
    for (let index = 1; index <= 5; index += 1) await clientPost(f, `203.0.113.${index}`)('/api/v1/account/logout');
    assert.equal(f.handle.services.limiter.size, 5);
    f.clock.tick(30_000);
    await clientPost(f, '203.0.113.9')('/api/v1/account/logout');
    assert.equal(f.handle.services.limiter.size, 6);
    f.clock.tick(30_001);
    // Only the key hit within the last window survives the sweep.
    assert.equal(f.handle.services.limiter.size, 1);
    f.clock.tick(60_000);
    assert.equal(f.handle.services.limiter.size, 0);
  } finally { f.handle.shutdown(); }
});

test('a single key is dropped as soon as its last hit expires', () => {
  let now = 0;
  const limiter = new SlidingWindowLimiter(() => now, 1, 1_000);
  assert.equal(limiter.allow('client'), true);
  assert.equal(limiter.allow('client'), false);
  assert.equal(limiter.retryAfterSeconds('client'), 1);
  now = 1_001;
  assert.equal(limiter.blocked('client'), false);
  assert.equal(limiter.size, 0);
});
