import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_PROTOCOL,
  ENROLLMENT_TTL_MS,
  RELAY_PROTOCOL,
  controllerEnrollmentClaimResultSchema,
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
} from '@gian/remote-protocol';

import {
  cookieHeader,
  enrollHost,
  listenRemoteApp,
  makeRemoteTestApp,
  pairDevice,
  signChallenge,
} from './fixture.js';

type TestFetch = Awaited<ReturnType<typeof makeRemoteTestApp>>['fetch'];

const post = (body: unknown, token?: string, cookie?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
  },
  body: JSON.stringify(body),
});

async function mintSharedEnrollment(fetch: TestFetch) {
  const response = await fetch('/api/v1/admin/host-enrollments', post({ protocol: AUTH_PROTOCOL }, 'admin-test-token'));
  assert.equal(response.status, 200);
  return await response.json() as { enrollment_token: string; expires_at: number };
}

async function createGrant(fetch: TestFetch, hostAccessToken: string) {
  const response = await fetch('/api/v1/host/pairings', post({ protocol: AUTH_PROTOCOL }, hostAccessToken));
  assert.equal(response.status, 200);
  return await response.json() as { code: string; grant_nonce: string };
}

async function loginController(fetch: TestFetch, browserId: string, keys: CryptoKeyPair) {
  const challengeResponse = await fetch('/api/v1/sessions/controller-challenge', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: browserId,
  }));
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json() as { challenge_id: string };
  const response = await fetch('/api/v1/sessions/controller-login', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: browserId,
    challenge_id: challenge.challenge_id,
    signature: await signChallenge(keys.privateKey, challenge.challenge_id),
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as { controller_access_token: string; browser_installation_id: string };
  assert.equal(body.browser_installation_id, browserId);
  return body.controller_access_token;
}

async function enrollNativeController(fetch: TestFetch, platform: 'iOS' | 'macOS') {
  const enrollment = await mintSharedEnrollment(fetch);
  const keys = await generateP256SigningKeyPair();
  const browserId = generateCanonicalId();
  const response = await fetch('/api/v1/controller-enrollments/claim', post({
    protocol: AUTH_PROTOCOL,
    enrollment_token: enrollment.enrollment_token,
    browser_installation_id: browserId,
    device_public_key: await exportPublicJwk(keys.publicKey),
    platform,
  }));
  assert.equal(response.status, 200);
  controllerEnrollmentClaimResultSchema.parse(await response.json());
  const accessToken = await loginController(fetch, browserId, keys);
  return { enrollment, keys, browserId, accessToken };
}

async function confirmPairing(fetch: TestFetch, pairingId: string, token: string) {
  return await fetch(`/api/v1/pairings/${pairingId}/confirm`, post({
    protocol: AUTH_PROTOCOL,
    pairing_id: pairingId,
    decision: 'confirm',
  }, token));
}

async function loginDevice(fetch: TestFetch, hostId: string, browserId: string, keys: CryptoKeyPair) {
  const challengeResponse = await fetch('/api/v1/sessions/device-challenge', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: browserId,
    host_id: hostId,
  }));
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json() as { challenge_id: string };
  const response = await fetch('/api/v1/sessions/device-login', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: browserId,
    host_id: hostId,
    challenge_id: challenge.challenge_id,
    signature: await signChallenge(keys.privateKey, challenge.challenge_id),
  }));
  assert.equal(response.status, 200);
  return {
    body: await response.json() as { access_token: string; device_id: string },
    cookies: response.headers.getSetCookie(),
  };
}

function openDeviceSocket(wsUrl: string, ticket: string) {
  const ws = new WebSocket(wsUrl);
  let boundResolve: (() => void) | undefined;
  let boundReject: ((error: Error) => void) | undefined;
  const bound = new Promise<void>((resolve, reject) => {
    boundResolve = resolve;
    boundReject = reject;
  });
  const timer = setTimeout(() => boundReject?.(new Error('device socket bind timeout')), 5_000);
  const closed = new Promise<number>(resolve => {
    ws.addEventListener('close', event => resolve(event.code));
  });
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ protocol: RELAY_PROTOCOL, type: 'ws.auth', ticket }));
  });
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as { type?: string };
    if (frame.type !== 'ws.bound') return;
    clearTimeout(timer);
    boundResolve?.();
    boundResolve = undefined;
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    boundReject?.(new Error('device socket failed'));
  });
  return { bound, closed, close: () => ws.close() };
}

test('iOS and Host claims share one short-lived admin enrollment token', async () => {
  const f = await makeRemoteTestApp();
  try {
    const native = await enrollNativeController(f.fetch, 'iOS');
    assert.equal(native.enrollment.expires_at, f.clock.now + ENROLLMENT_TTL_MS);
    const replayKeys = await generateP256SigningKeyPair();
    const replay = await f.fetch('/api/v1/controller-enrollments/claim', post({
      protocol: AUTH_PROTOCOL,
      enrollment_token: native.enrollment.enrollment_token,
      browser_installation_id: generateCanonicalId(),
      device_public_key: await exportPublicJwk(replayKeys.publicKey),
      platform: 'iOS',
    }));
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as { error: { code: string } }).error.code, 'ENROLLMENT_CONSUMED');
    const hostReplay = await f.fetch('/api/v1/host-enrollments/claim', post({
      protocol: AUTH_PROTOCOL,
      enrollment_token: native.enrollment.enrollment_token,
      host_name: 'Late Host',
      host_version: '0.6.10',
      host_public_key: await exportPublicJwk(replayKeys.publicKey),
    }));
    assert.equal(hostReplay.status, 401);
  } finally { f.handle.shutdown(); }
});

test('Host enrollment admits the Host key and an old Host can backfill admission with its bearer', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const publicKey = await exportPublicJwk(host.keys.publicKey);
    const automatic = f.handle.services.repos.getController(host.hostId);
    assert.equal(automatic?.platform, 'macOS');
    assert.deepEqual(JSON.parse(automatic!.public_key_jwk), publicKey);
    const controllerToken = await loginController(f.fetch, host.hostId, host.keys);
    f.handle.services.db.prepare('DELETE FROM controller_devices WHERE browser_installation_id = ?').run(host.hostId);
    assert.equal(f.handle.services.repos.getController(host.hostId), undefined);
    const denied = await f.fetch('/api/v1/controller-enrollments/host-claim', post({
      protocol: AUTH_PROTOCOL,
      platform: 'macOS',
    }, controllerToken));
    assert.equal(denied.status, 401);
    const backfilled = await f.fetch('/api/v1/controller-enrollments/host-claim', post({
      protocol: AUTH_PROTOCOL,
      platform: 'macOS',
    }, host.accessToken));
    assert.equal(backfilled.status, 200);
    const result = controllerEnrollmentClaimResultSchema.parse(await backfilled.json());
    assert.equal(result.browser_installation_id, host.hostId);
    assert.deepEqual(JSON.parse(f.handle.services.repos.getController(host.hostId)!.public_key_jwk), publicKey);
  } finally { f.handle.shutdown(); }
});

test('declared native pairing needs its controller token while undeclared Web pairing stays Host-confirmed', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const native = await enrollNativeController(f.fetch, 'macOS');
    const other = await enrollNativeController(f.fetch, 'iOS');
    const deniedGrant = await f.fetch('/api/v1/host/pairings', post({
      protocol: AUTH_PROTOCOL,
    }, native.accessToken));
    assert.equal(deniedGrant.status, 401);

    const nativeGrant = await createGrant(f.fetch, host.accessToken);
    const nativeClaim = {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      device_public_key: await exportPublicJwk(native.keys.publicKey),
      platform: 'macOS',
      user_agent: 'Gian Desktop',
      controller_admission: 1,
      code: nativeGrant.code,
    };
    const missingToken = await f.fetch('/api/v1/pairings/claim', post(nativeClaim));
    assert.equal(missingToken.status, 401);
    assert.equal((await missingToken.json() as { error: { code: string } }).error.code, 'CONTROLLER_NOT_ADMITTED');
    const wrongToken = await f.fetch('/api/v1/pairings/claim', post(nativeClaim, other.accessToken));
    assert.equal(wrongToken.status, 401);
    const claimed = await f.fetch('/api/v1/pairings/claim', post(nativeClaim, native.accessToken));
    assert.equal(claimed.status, 200);
    const pairing = await claimed.json() as { pairing_id: string; status: string };
    assert.equal(pairing.status, 'pending_confirmation');
    assert.equal((await confirmPairing(f.fetch, pairing.pairing_id, native.accessToken)).status, 401);
    assert.equal((await confirmPairing(f.fetch, pairing.pairing_id, host.accessToken)).status, 200);

    const webGrant = await createGrant(f.fetch, host.accessToken);
    const webKeys = await generateP256SigningKeyPair();
    const webClaim = {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: generateCanonicalId(),
      device_public_key: await exportPublicJwk(webKeys.publicKey),
      platform: 'iOS',
      user_agent: 'native-looking metadata is not proof',
      code: webGrant.code,
    };
    const invalidDeclaration = await f.fetch('/api/v1/pairings/claim', post({
      ...webClaim,
      controller_admission: 0,
    }));
    assert.equal(invalidDeclaration.status, 400);
    const web = await f.fetch('/api/v1/pairings/claim', post(webClaim));
    assert.equal(web.status, 200);
    const webPairing = await web.json() as { pairing_id: string; status: string };
    assert.equal(webPairing.status, 'pending_confirmation');
    assert.equal(f.handle.services.repos.getPairing(webPairing.pairing_id)?.confirmed_at, null);
    assert.equal((await confirmPairing(f.fetch, webPairing.pairing_id, host.accessToken)).status, 200);
  } finally { f.handle.shutdown(); }
});

test('confirmed legacy pairing migrates by old-key proof; revoked, pending, and keyless pairings cannot', async () => {
  const f = await makeRemoteTestApp();
  try {
    const host = await enrollHost(f.fetch);
    const legacy = await pairDevice(f.fetch, host.accessToken, host.hostId);
    const controllerKeys = await generateP256SigningKeyPair();
    const challengeResponse = await f.fetch('/api/v1/controller-migrations/challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: legacy.browserId,
      host_id: host.hostId,
      device_public_key: await exportPublicJwk(controllerKeys.publicKey),
    }));
    assert.equal(challengeResponse.status, 200);
    const challenge = await challengeResponse.json() as { challenge_id: string };
    const wrongKeys = await generateP256SigningKeyPair();
    const loginBody = {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: legacy.browserId,
      host_id: host.hostId,
      challenge_id: challenge.challenge_id,
    };
    const wrong = await f.fetch('/api/v1/controller-migrations/login', post({
      ...loginBody,
      signature: await signChallenge(wrongKeys.privateKey, challenge.challenge_id),
    }));
    assert.equal(wrong.status, 401);
    const migrated = await f.fetch('/api/v1/controller-migrations/login', post({
      ...loginBody,
      signature: await signChallenge(legacy.keys.privateKey, challenge.challenge_id),
    }));
    assert.equal(migrated.status, 200);
    assert.equal((await migrated.json() as { browser_installation_id: string }).browser_installation_id, legacy.browserId);
    assert.deepEqual(
      JSON.parse(f.handle.services.repos.getController(legacy.browserId)!.public_key_jwk),
      await exportPublicJwk(controllerKeys.publicKey),
    );
    const replay = await f.fetch('/api/v1/controller-migrations/login', post({
      ...loginBody,
      signature: await signChallenge(legacy.keys.privateKey, challenge.challenge_id),
    }));
    assert.equal(replay.status, 409);

    const pendingBrowser = generateCanonicalId();
    const pendingKeys = await generateP256SigningKeyPair();
    const pendingGrant = await createGrant(f.fetch, host.accessToken);
    const pending = await f.fetch('/api/v1/pairings/claim', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: pendingBrowser,
      device_public_key: await exportPublicJwk(pendingKeys.publicKey),
      platform: 'macOS',
      user_agent: 'legacy',
      code: pendingGrant.code,
    }));
    assert.equal(pending.status, 200);

    const revoked = await pairDevice(f.fetch, host.accessToken, host.hostId);
    f.handle.services.repos.revokePairing(revoked.deviceId);

    const keylessBrowser = generateCanonicalId();
    f.handle.services.repos.ensureBrowser(keylessBrowser);
    f.handle.services.db.prepare(`INSERT INTO device_host_pairings(
      id, browser_installation_id, host_id, public_key_jwk, platform, user_agent, created_at, confirmed_at
    ) VALUES (?, ?, ?, '', 'legacy', 'legacy', ?, ?)`).run(
      generateCanonicalId(), keylessBrowser, host.hostId, f.clock.now, f.clock.now,
    );

    for (const [browserId, expectedCode] of [
      [pendingBrowser, 'DEVICE_NOT_PAIRED'],
      [revoked.browserId, 'DEVICE_REVOKED'],
      [keylessBrowser, 'DEVICE_NOT_PAIRED'],
    ] as const) {
      const denied = await f.fetch('/api/v1/controller-migrations/challenge', post({
        protocol: AUTH_PROTOCOL,
        browser_installation_id: browserId,
        host_id: host.hostId,
        device_public_key: await exportPublicJwk((await generateP256SigningKeyPair()).publicKey),
      }));
      assert.equal(denied.status, 401);
      assert.equal((await denied.json() as { error: { code: string } }).error.code, expectedCode);
    }
  } finally { f.handle.shutdown(); }
});

test('controller revocation blocks pairing, device sessions, refresh, tickets, and the live relay route', async () => {
  const f = await makeRemoteTestApp();
  const listened = await listenRemoteApp(f.handle, 0);
  let socket: ReturnType<typeof openDeviceSocket> | undefined;
  try {
    const host = await enrollHost(f.fetch);
    const native = await enrollNativeController(f.fetch, 'iOS');
    const grant = await createGrant(f.fetch, host.accessToken);
    const claim = await f.fetch('/api/v1/pairings/claim', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      device_public_key: await exportPublicJwk(native.keys.publicKey),
      platform: 'iOS',
      user_agent: 'Gian iOS',
      controller_admission: 1,
      code: grant.code,
    }, native.accessToken));
    assert.equal(claim.status, 200);
    const pairing = await claim.json() as { pairing_id: string };
    assert.equal((await confirmPairing(f.fetch, pairing.pairing_id, host.accessToken)).status, 200);
    const device = await loginDevice(f.fetch, host.hostId, native.browserId, native.keys);
    const refreshCookie = cookieHeader(device.cookies);
    for (const path of ['/api/v1/me', '/api/v1/hosts']) {
      const response = await f.fetch(path, { headers: { cookie: refreshCookie } });
      assert.equal(response.status, 200);
    }
    const unusedGrant = await createGrant(f.fetch, host.accessToken);
    const pendingChallengeResponse = await f.fetch('/api/v1/sessions/device-challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      host_id: host.hostId,
    }));
    assert.equal(pendingChallengeResponse.status, 200);
    const pendingChallenge = await pendingChallengeResponse.json() as { challenge_id: string };
    const ticketResponse = await f.fetch('/api/v1/ws-tickets', post({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
    }, device.body.access_token));
    assert.equal(ticketResponse.status, 200);
    const ticket = await ticketResponse.json() as { ticket: string };
    socket = openDeviceSocket(listened.wsUrl, ticket.ticket);
    await socket.bound;

    const revoked = await f.fetch(`/api/v1/admin/controllers/${native.browserId}/revoke`, post({
      protocol: AUTH_PROTOCOL,
    }, 'admin-test-token'));
    assert.equal(revoked.status, 200);
    assert.equal(await socket.closed, 4001);
    for (const path of ['/api/v1/me', '/api/v1/hosts']) {
      const response = await f.fetch(path, { headers: { cookie: refreshCookie } });
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'AUTH_REQUIRED');
    }

    const denied: Array<[Response, string]> = [];
    denied.push([await f.fetch('/api/v1/pairings/claim', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      device_public_key: await exportPublicJwk(native.keys.publicKey),
      platform: 'iOS',
      user_agent: 'Gian iOS',
      controller_admission: 1,
      code: unusedGrant.code,
    }, native.accessToken)), 'CONTROLLER_REVOKED']);
    denied.push([await f.fetch('/api/v1/sessions/controller-challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
    })), 'CONTROLLER_REVOKED']);
    denied.push([await f.fetch('/api/v1/sessions/device-challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      host_id: host.hostId,
    })), 'CONTROLLER_REVOKED']);
    denied.push([await f.fetch('/api/v1/sessions/device-login', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: native.browserId,
      host_id: host.hostId,
      challenge_id: pendingChallenge.challenge_id,
      signature: await signChallenge(native.keys.privateKey, pendingChallenge.challenge_id),
    })), 'CONTROLLER_REVOKED']);
    denied.push([await f.fetch('/api/v1/sessions/refresh', post({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
    }, undefined, cookieHeader(device.cookies))), 'CONTROLLER_REVOKED']);
    for (const [response, code] of denied) {
      assert.equal(response.status, 401);
      assert.equal((await response.json() as { error: { code: string } }).error.code, code);
    }
    assert.equal((await f.fetch('/api/v1/ws-tickets', post({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
    }, device.body.access_token))).status, 401);
  } finally {
    socket?.close();
    listened.close();
  }
});
