import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ACCOUNT_PROTOCOL, AUTH_PROTOCOL, ENROLLMENT_TTL_MS, exportPublicJwk, generateP256SigningKeyPair,
  accountLoginStartedSchema, generateCanonicalId, hostEnrollmentClaimResultSchema, remoteAccountChallengePayload, signBytes } from '@gian/remote-protocol';

import { cookieHeader, enrollHost, makeRemoteTestApp, pairDevice, authorizeAccount } from './fixture.js';
import { createEnrollmentFromEnv } from '../src/enrollment-command.js';
import { parseEnrollmentGithubIds } from '../src/config.js';
import { hashEnrollmentPassword } from '../src/auth/enrollment-password.js';

const post = (body: unknown, cookie?: string, csrf?: string): RequestInit => ({ method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-gian-csrf': csrf } : {}) },
  body: JSON.stringify(body) });

async function enrollmentCsrf(f: Awaited<ReturnType<typeof makeRemoteTestApp>>) {
  const response = await f.fetch('/api/v1/enrollment/csrf');
  const body = await response.json() as { csrf_token: string };
  return { token: body.csrf_token, cookie: cookieHeader(response.headers.getSetCookie()), response };
}

async function enrollmentLogin(f: Awaited<ReturnType<typeof makeRemoteTestApp>>, password = 'page-secret') {
  const csrf = await enrollmentCsrf(f);
  const response = await f.fetch('/api/v1/enrollment/login', post({ protocol: AUTH_PROTOCOL, password }, csrf.cookie, csrf.token));
  return { response, cookie: cookieHeader([...csrf.response.headers.getSetCookie(), ...response.headers.getSetCookie()]), csrf: csrf.token };
}

test('GitHub transport failure is unavailable, not bad credentials, and never leaks upstream errors', async () => {
  const f = await makeRemoteTestApp({ config: { githubFetch: async () => { throw new Error('private-upstream-fixture'); } } });
  try {
    const keys = await generateP256SigningKeyPair();
    const removed = await f.fetch('/api/v1/enrollment/account/start', post({ protocol: ACCOUNT_PROTOCOL,
      peer: { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) } }));
    assert.equal(removed.status, 404);
    const response = await f.fetch('/api/v1/account/start', post({ protocol: ACCOUNT_PROTOCOL,
      peer: { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) } }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'UPSTREAM_FAILED');
    assert.doesNotMatch(f.logs.join('\n'), /private-upstream-fixture/);
    assert.equal(f.handle.services.db.prepare('SELECT * FROM enrollment_sessions').get(), undefined);
  } finally { f.handle.shutdown(); }
});

test('enrollment keeps the same signed login through timeout and rate limiting, with backoff and no deadline extension', async () => {
  let mode: 'timeout' | 'rate' | 'authorized' = 'timeout';
  let polls = 0;
  const f = await makeRemoteTestApp({ config: { githubFetch: async url => {
    if (String(url).endsWith('/login/device/code')) return Response.json({ device_code: 'fixture-device', user_code: 'CODE',
      verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    if (String(url).endsWith('/login/oauth/access_token')) {
      polls += 1;
      if (mode === 'timeout') throw new TypeError('connect timeout');
      if (mode === 'rate') return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
      return Response.json({ access_token: 'fixture-access-token', token_type: 'bearer' });
    }
    return Response.json({ id: 42, login: 'owner', type: 'User' });
  } } });
  try {
    const keys = await generateP256SigningKeyPair();
    const started = accountLoginStartedSchema.parse(await (await f.fetch('/api/v1/account/start', post({
      protocol: ACCOUNT_PROTOCOL, peer: { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) },
    }))).json());
    const proof = { protocol: ACCOUNT_PROTOCOL, login_id: started.login_id,
      signature: await signBytes(keys.privateKey, new TextEncoder().encode(remoteAccountChallengePayload(started.challenge))) };
    const poll = () => f.fetch('/api/v1/account/poll', post(proof));
    const unavailable = await poll();
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.headers.get('retry-after'), '10');
    assert.equal(unavailable.headers.get('set-cookie'), null);
    assert.equal((await (await poll()).json() as { status: string }).status, 'pending');
    assert.equal(polls, 1, 'early retries never hit GitHub');
    f.clock.tick(10_000);
    mode = 'rate';
    const limited = await poll();
    assert.equal(limited.status, 503);
    assert.equal(limited.headers.get('retry-after'), '30');
    f.clock.tick(29_999);
    assert.equal((await (await poll()).json() as { status: string }).status, 'pending');
    assert.equal(polls, 2);
    f.clock.tick(1);
    mode = 'authorized';
    const accepted = await poll();
    assert.equal((await accepted.json() as { status: string }).status, 'authorized');
    assert.equal(accepted.headers.get('set-cookie'), null);
    assert.equal(polls, 3);

    mode = 'timeout';
    const second = accountLoginStartedSchema.parse(await (await f.fetch('/api/v1/account/start', post({
      protocol: ACCOUNT_PROTOCOL, peer: { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) },
    }))).json());
    const secondProof = { protocol: ACCOUNT_PROTOCOL, login_id: second.login_id,
      signature: await signBytes(keys.privateKey, new TextEncoder().encode(remoteAccountChallengePayload(second.challenge))) };
    assert.equal((await f.fetch('/api/v1/account/poll', post(secondProof))).status, 503);
    f.clock.tick(second.expires_at - f.clock.now);
    const expired = await f.fetch('/api/v1/account/poll', post(secondProof));
    assert.equal((await expired.json() as { status: string }).status, 'expired');
    assert.equal(expired.headers.get('set-cookie'), null);
    assert.equal(polls, 4, 'expiry stops retries rather than extending the login');
  } finally { f.handle.shutdown(); }
});

test('enrollment allowlist is configurable, numeric, deduplicated and default-deny', async () => {
  assert.deepEqual(parseEnrollmentGithubIds(undefined), []);
  assert.deepEqual(parseEnrollmentGithubIds('42, 99,42'), ['42', '99']);
  for (const invalid of ['owner', '0', '42,', '1.2', '-42']) assert.throws(() => parseEnrollmentGithubIds(invalid));
  const f = await makeRemoteTestApp({ config: { enrollmentGithubIds: [] } });
  try {
    assert.equal((await f.fetch('/api/v1/enrollment/account/start', post({}))).status, 404);
    assert.equal((await f.fetch('/api/v1/admin/host-enrollments', { ...post({ protocol: AUTH_PROTOCOL }),
      headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' } })).status, 200);
  } finally { f.handle.shutdown(); }
});

test('enrollment page login issues a separate secure cookie, never OAuth or account bearer credentials', async () => {
  const hash = await hashEnrollmentPassword('page-secret');
  const f = await makeRemoteTestApp({ config: { enrollmentPasswordHash: hash } });
  try {
    const host = await enrollHost(f.fetch);
    const paired = await pairDevice(f.fetch, host.accessToken, host.hostId);
    const { response, cookie, csrf } = await enrollmentLogin(f);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(JSON.parse(text).ok, true);
    assert.doesNotMatch(text, /account_token|test-oauth-token|device_code|admin-test-token|page-secret/);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(response.headers.get('set-cookie')!, /Secure/);
    assert.match(response.headers.get('set-cookie')!, /SameSite=Strict/);
    assert.match(response.headers.get('set-cookie')!, /Path=\/api\/v1\/enrollment/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }))).status, 401);
    assert.equal((await f.fetch('/api/v1/enrollment/session', { headers: { cookie } })).status, 200);
    const issuedResponse = await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf));
    assert.equal(issuedResponse.status, 200);
    const issued = await issuedResponse.json() as { enrollment_token: string; expires_at: number };
    assert.equal(issued.expires_at, f.clock.now + 300_000);
    const rows = f.handle.services.db.prepare('SELECT * FROM host_enrollments').all() as Array<{ github_account_id: string | null }>;
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(issued.enrollment_token));
    assert.equal(rows.at(-1)?.github_account_id ?? null, null);
    const ignored = await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL, github_account_id: '99' }, cookie, csrf));
    assert.equal(ignored.status, 200);
    assert.equal((f.handle.services.db.prepare('SELECT github_account_id FROM host_enrollments WHERE github_account_id IS NOT NULL').get()), undefined);
    for (const origin of ['', 'https://attacker.test']) {
      const blocked = await f.handle.app.fetch(new Request('https://remote.test/api/v1/enrollment/tokens', {
        ...post({ protocol: AUTH_PROTOCOL }), headers: { cookie, origin, 'content-type': 'application/json', 'x-gian-csrf': csrf },
      }));
      assert.equal(blocked.status, 403);
    }
    assert.equal((await f.fetch('/api/v1/enrollment/logout', post({}, cookie, csrf))).status, 200);
    assert.equal((await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf))).status, 401);
    assert.equal((await f.fetch('/api/v1/me', { headers: { cookie: cookieHeader(paired.cookies) } })).status, 200);
  } finally { f.handle.shutdown(); }
});

test('enrollment password rejects the admin token, a missing verifier, CSRF mistakes, and repeated failures', async () => {
  const hash = await hashEnrollmentPassword('admin-test-token');
  const f = await makeRemoteTestApp({ config: { enrollmentPasswordHash: hash } });
  try {
    const csrf = await enrollmentCsrf(f);
    const attempt = (password: string, header = csrf.token) => f.fetch('/api/v1/enrollment/login',
      post({ protocol: AUTH_PROTOCOL, password }, csrf.cookie, header));
    assert.equal((await attempt('admin-test-token')).status, 401);
    const missing = await makeRemoteTestApp();
    const missingCsrf = await enrollmentCsrf(missing);
    const disabled = await missing.fetch('/api/v1/enrollment/login', post({ protocol: AUTH_PROTOCOL, password: 'page-secret' }, missingCsrf.cookie, missingCsrf.token));
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json() as { error: { code: string } }).error.code, 'ENROLLMENT_DISABLED');
    missing.handle.shutdown();
    assert.equal((await attempt('page-secret', 'not-the-csrf')).status, 403);
    for (let i = 0; i < 3; i += 1) assert.equal((await attempt('nope')).status, 401);
    const locked = await attempt('admin-test-token');
    assert.equal(locked.status, 429);
    assert.equal((await locked.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
  } finally { f.handle.shutdown(); }
});

test('web token issuance is rate limited independently of a GitHub allowlist', async () => {
  const hash = await hashEnrollmentPassword('page-secret');
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1, enrollmentPasswordHash: hash, enrollmentGithubIds: [] } });
  try {
    const { cookie, csrf } = await enrollmentLogin(f);
    assert.equal((await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf))).status, 429);
  } finally { f.handle.shutdown(); }
});

test('a changed enrollment password stops later issuance and does not revoke an enrolled Host', async () => {
  const hash = await hashEnrollmentPassword('page-secret');
  const f = await makeRemoteTestApp({ config: { enrollmentPasswordHash: hash } });
  try {
    const host = await enrollHost(f.fetch);
    const { cookie, csrf } = await enrollmentLogin(f);
    const issued = await (await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf))).json() as { enrollment_token: string };
    f.handle.services.config.enrollmentPasswordHash = await hashEnrollmentPassword('next-secret');
    assert.equal((await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf))).status, 401);
    const keys = await generateP256SigningKeyPair();
    const claim = await f.fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, enrollment_token: issued.enrollment_token, host_name: 'Spare',
        host_version: '0.6.9', host_public_key: await exportPublicJwk(keys.publicKey) }),
    });
    assert.equal(claim.status, 200);
    assert.equal(f.handle.services.repos.getHost(host.hostId)?.revoked_at ?? null, null);
    assert.equal((await f.fetch('/api/v1/host/heartbeat', post({ protocol: AUTH_PROTOCOL }, undefined, undefined))).status, 401);
    assert.equal((await f.fetch('/api/v1/host/heartbeat', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.accessToken}` },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).status, 200);
  } finally { f.handle.shutdown(); }
});

test('a presented GitHub token does not bind or block a one-time enrollment claim', async () => {
  const hash = await hashEnrollmentPassword('page-secret');
  const f = await makeRemoteTestApp({ config: { enrollmentPasswordHash: hash } });
  try {
    const { cookie, csrf } = await enrollmentLogin(f);
    const issued = await (await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL, github_account_id: '42' }, cookie, csrf))).json() as { enrollment_token: string };
    const wrongKeys = await generateP256SigningKeyPair();
    const wrong = await authorizeAccount(f.fetch, wrongKeys, 'host');
    const claim = async (token: string, keys: CryptoKeyPair, enrollmentToken = issued.enrollment_token) => f.fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gian-account-token': token },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, enrollment_token: enrollmentToken, host_name: 'Mac',
        host_version: '0.6.3', host_public_key: await exportPublicJwk(keys.publicKey) }),
    });
    assert.equal((await claim(wrong.token, wrongKeys)).status, 200);
    assert.equal((await claim(wrong.token, wrongKeys)).status, 401);
    const fresh = await (await f.fetch('/api/v1/enrollment/tokens', post({ protocol: AUTH_PROTOCOL }, cookie, csrf))).json() as { enrollment_token: string };
    f.clock.tick(ENROLLMENT_TTL_MS + 1);
    assert.equal((await claim(wrong.token, await generateP256SigningKeyPair(), fresh.enrollment_token)).status, 401);
  } finally { f.handle.shutdown(); }
});

test('enrollment command uses only the local admin endpoint and returns a claimable token', async () => {
  const context = await makeRemoteTestApp();
  try {
    const issued = await createEnrollmentFromEnv({
      GIAN_REMOTE_ADMIN_TOKEN: 'admin-test-token', GIAN_REMOTE_PUBLIC_ORIGIN: 'https://remote.test',
      GIAN_REMOTE_HOST: '0.0.0.0', GIAN_REMOTE_PORT: '8787',
    }, 'Home Mac', (async (url, init) => {
      assert.equal(String(url), 'http://127.0.0.1:8787/api/v1/admin/host-enrollments');
      assert.equal(init?.redirect, 'error');
      return context.fetch(new URL(String(url)).pathname, init);
    }) as typeof fetch);
    assert.equal(issued.server_url, 'https://remote.test');
    assert.equal(Date.parse(issued.expires_at), context.clock.now + ENROLLMENT_TTL_MS);
    assert.ok(context.handle.services.repos.claimEnrollment(issued.enrollment_token, {
      name: 'Home Mac', public_key_jwk: 'fixture-key',
    }));
    assert.doesNotMatch(JSON.stringify(issued), /admin-test-token/);
  } finally { context.handle.shutdown(); }
});

test('enrollment command rejects bad configuration and never echoes an error body or credential', async () => {
  const env = { GIAN_REMOTE_ADMIN_TOKEN: 'private-admin', GIAN_REMOTE_PUBLIC_ORIGIN: 'https://remote.test' };
  await assert.rejects(createEnrollmentFromEnv({ ...env, GIAN_REMOTE_PORT: '0' }), /Invalid GIAN_REMOTE_PORT/);
  await assert.rejects(createEnrollmentFromEnv({ ...env, GIAN_REMOTE_ADMIN_TOKEN: '' }), /is required/);
  await assert.rejects(createEnrollmentFromEnv(env, undefined, (async () => new Response('private-admin', { status: 401 })) as typeof fetch), error => {
    assert.match(String(error), /HTTP 401/);
    assert.doesNotMatch(String(error), /private-admin/);
    return true;
  });
});

test('Host profile rename changes only the authenticated Host and preserves existing pairings', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  try {
    const first = await enrollHost(fetch);
    const second = await enrollHost(fetch);
    const device = await pairDevice(fetch, first.accessToken, first.hostId);
    const send = (body: object, token?: string) => fetch('/api/v1/host/profile', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, ...body }),
    });
    assert.equal((await send({ name: 'Home Mac' })).status, 401);
    assert.equal((await send({ name: 'Home Mac' }, device.accessToken)).status, 401);
    assert.equal((await send({ name: 'Home Mac', host_id: second.hostId }, first.accessToken)).status, 400);
    assert.equal((await send({ name: '   ' }, first.accessToken)).status, 400);
    const originalSecondName = handle.services.repos.getHost(second.hostId)!.name;
    assert.equal((await send({ name: 'Home Mac' }, first.accessToken)).status, 200);
    assert.equal(handle.services.repos.getHost(first.hostId)!.name, 'Home Mac');
    assert.equal(handle.services.repos.getHost(second.hostId)!.name, originalSecondName);
    assert.equal(handle.services.repos.getPairing(device.deviceId)!.host_id, first.hostId);
    const me = await (await fetch('/api/v1/me', { headers: { cookie: cookieHeader(device.cookies) } })).json() as { hosts: Array<{ name: string }> };
    assert.equal(me.hosts[0]!.name, 'Home Mac');
  } finally { handle.shutdown(); }
});

test('enrollment token is single-use, expires, and concurrent claim loses', async () => {
  const { fetch, clock, handle } = await makeRemoteTestApp();
  const keys = await generateP256SigningKeyPair();
  const account = await authorizeAccount(fetch, keys, 'host');
  const publicKey = await exportPublicJwk(keys.publicKey);
  const host = await enrollHost(fetch);
  assert.ok(host.hostId);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const firstClaim = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Second',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  });
  assert.equal(firstClaim.status, 200);
  const firstClaimBody = await firstClaim.json() as { host_id: string };
  assert.notEqual(firstClaimBody.host_id, host.hostId);
  const reuse = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Other',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  });
  assert.equal(reuse.status, 401);

  const second = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  assert.equal(ENROLLMENT_TTL_MS, 5 * 60 * 1000);
  clock.tick(ENROLLMENT_TTL_MS);
  const expired = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: second.enrollment_token,
      host_name: 'Late',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  });
  assert.equal(expired.status, 401);
  handle.shutdown();
});

test('concurrent enrollment claims consume the token once', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const keys = await generateP256SigningKeyPair();
  const account = await authorizeAccount(fetch, keys, 'host');
  const publicKey = await exportPublicJwk(keys.publicKey);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const body = {
    protocol: AUTH_PROTOCOL,
    enrollment_token: created.enrollment_token,
    host_name: 'Race',
    host_version: '0.5.3',
    host_public_key: publicKey,
  };
  const [first, second] = await Promise.all([
    fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
      body: JSON.stringify(body),
    }),
    fetch('/api/v1/host-enrollments/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
      body: JSON.stringify({ ...body, host_name: 'Race-2' }),
    }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 401]);
  handle.shutdown();
});

test('re-enrolling the same Host identity reuses its id and existing browser pairing', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const first = await enrollHost(fetch);
  const device = await pairDevice(fetch, first.accessToken, first.hostId);
  const publicKey = await exportPublicJwk(first.keys.publicKey);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };

  const response = await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': first.accountToken },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Renamed Office Mac',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  });
  assert.equal(response.status, 200);
  const claimed = await response.json() as { host_id: string };
  assert.equal(claimed.host_id, first.hostId);
  const hostCount = handle.services.repos.db.prepare(
    'SELECT COUNT(*) count FROM hosts',
  ).get() as { count: number };
  assert.equal(hostCount.count, 1);
  assert.equal(handle.services.repos.getPairing(device.deviceId)?.host_id, first.hostId);
  const me = await fetch('/api/v1/me', {
    headers: { cookie: cookieHeader(device.cookies) },
  });
  assert.equal(me.status, 200);
  assert.deepEqual(
    (await me.json() as { hosts: Array<{ host_id: string }> }).hosts.map(host => host.host_id),
    [first.hostId],
  );
  handle.shutdown();
});

test('/health has no host or device identifiers and enrollment returns app identity', async () => {
  const { fetch, handle } = await makeRemoteTestApp();
  const keys = await generateP256SigningKeyPair();
  const account = await authorizeAccount(fetch, keys, 'host');
  const publicKey = await exportPublicJwk(keys.publicKey);
  const health = await (await fetch('/health')).json() as Record<string, unknown>;
  assert.equal(health.ok, true);
  assert.equal('host_id' in health, false);
  assert.equal('device_id' in health, false);
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: {
      authorization: 'Bearer admin-test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const claimed = await (await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gian-account-token': account.token },
    body: JSON.stringify({
      protocol: AUTH_PROTOCOL,
      enrollment_token: created.enrollment_token,
      host_name: 'Identity',
      host_version: '0.5.3',
      host_public_key: publicKey,
    }),
  })).json() as { server_identity?: { fingerprint?: string; algorithm?: string } };
  assert.equal(claimed.server_identity?.algorithm, 'P-256');
  assert.equal(typeof claimed.server_identity?.fingerprint, 'string');
  assert.deepEqual(Object.keys(claimed).sort(), ['connector_refresh_secret', 'host_id', 'protocol', 'server_identity']);
  assert.deepEqual(Object.keys(claimed.server_identity ?? {}).sort(), ['algorithm', 'fingerprint', 'public_key']);
  hostEnrollmentClaimResultSchema.parse(claimed);
  handle.shutdown();
});

test('a GitHub upstream failure answers 503 UPSTREAM_FAILED, never a misleading 401', async () => {
  const f = await makeRemoteTestApp({ config: { githubFetch: async () => new Response('rate limited', { status: 403 }) } });
  try {
    const keys = await generateP256SigningKeyPair();
    const peer = { role: 'controller', installation_id: generateCanonicalId(), public_key: await exportPublicJwk(keys.publicKey) };
    const enrollment = await f.fetch('/api/v1/enrollment/account/start', post({ protocol: ACCOUNT_PROTOCOL, peer }));
    assert.equal(enrollment.status, 404);
    const general = await f.fetch('/api/v1/account/start', post({ protocol: ACCOUNT_PROTOCOL, peer: { ...peer, role: 'host' } }));
    assert.equal(general.status, 503);
    assert.equal((await general.json()).error.code, 'UPSTREAM_FAILED');
  } finally { f.handle.shutdown(); }
});
