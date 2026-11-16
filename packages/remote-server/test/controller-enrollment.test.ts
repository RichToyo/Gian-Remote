import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AUTH_PROTOCOL,
  ENROLLMENT_TTL_MS,
  PAIRING_TTL_MS,
  RELAY_PROTOCOL,
  controllerEnrollmentClaimResultSchema,
  exportPublicJwk,
  generateCanonicalId,
  generateP256SigningKeyPair,
  selfRevokePayload,
  signBytes,
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

interface AdmittedController { browserId: string; keys: CryptoKeyPair; accessToken: string }

/** A desktop Gian: its Host identity key is admitted as its controller key. */
async function enrollDesktopController(fetch: TestFetch): Promise<AdmittedController> {
  const desktop = await enrollHost(fetch);
  return {
    browserId: desktop.hostId,
    keys: desktop.keys,
    accessToken: await loginController(fetch, desktop.hostId, desktop.keys),
  };
}

async function claimAsController(fetch: TestFetch, controller: AdmittedController, code: string, keys = controller.keys) {
  return await fetch('/api/v1/pairings/claim', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: controller.browserId,
    device_public_key: await exportPublicJwk(keys.publicKey),
    platform: 'macOS',
    user_agent: 'Gian Desktop',
    controller_admission: 1,
    code,
  }, controller.accessToken));
}

/** A fresh grant, claimed by the controller with its key and confirmed by the Host. */
async function pairController(fetch: TestFetch, host: { hostId: string; accessToken: string }, controller: AdmittedController) {
  const grant = await createGrant(fetch, host.accessToken);
  const claimed = await claimAsController(fetch, controller, grant.code);
  assert.equal(claimed.status, 200);
  const { pairing_id: pairingId } = await claimed.json() as { pairing_id: string };
  assert.equal((await confirmPairing(fetch, pairingId, host.accessToken)).status, 200);
  const device = await loginDevice(fetch, host.hostId, controller.browserId, controller.keys);
  assert.equal(device.body.device_id, pairingId);
  return { code: grant.code, pairingId, accessToken: device.body.access_token, cookie: cookieHeader(device.cookies) };
}

/** 200, or the refusal code of a device challenge. */
async function deviceChallenge(fetch: TestFetch, hostId: string, browserId: string): Promise<number | string> {
  const response = await fetch('/api/v1/sessions/device-challenge', post({
    protocol: AUTH_PROTOCOL,
    browser_installation_id: browserId,
    host_id: hostId,
  }));
  return response.status === 200 ? 200 : (await response.json() as { error: { code: string } }).error.code;
}

async function ticketStatus(fetch: TestFetch, hostId: string, accessToken: string): Promise<number> {
  return (await fetch('/api/v1/ws-tickets', post({ protocol: AUTH_PROTOCOL, host_id: hostId }, accessToken))).status;
}

async function refreshStatus(fetch: TestFetch, hostId: string, cookie: string): Promise<number> {
  return (await fetch('/api/v1/sessions/refresh', post({ protocol: AUTH_PROTOCOL, host_id: hostId }, undefined, cookie))).status;
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
    const admitted = await enrollNativeController(f.fetch, 'iOS');
    const duplicate = await f.fetch('/api/v1/controller-migrations/challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: legacy.browserId,
      host_id: host.hostId,
      device_public_key: await exportPublicJwk(admitted.keys.publicKey),
    }));
    assert.equal(duplicate.status, 409);
    assert.equal((await duplicate.json() as { error: { code: string } }).error.code, 'CONTROLLER_ALREADY_ADMITTED');
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

test('an admitted controller pairs its own key again over an active pairing only through a fresh grant the Host confirms', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1_000 } });
  const listened = await listenRemoteApp(f.handle, 0);
  let socket: ReturnType<typeof openDeviceSocket> | undefined;
  try {
    const repos = f.handle.services.repos;
    const host = await enrollHost(f.fetch);
    const desktop = await enrollDesktopController(f.fetch);
    const publicKeyJwk = JSON.stringify(await exportPublicJwk(desktop.keys.publicKey));
    const first = await pairController(f.fetch, host, desktop);
    const ticket = await (await f.fetch('/api/v1/ws-tickets', post({
      protocol: AUTH_PROTOCOL,
      host_id: host.hostId,
    }, first.accessToken))).json() as { ticket: string };
    socket = openDeviceSocket(listened.wsUrl, ticket.ticket);
    await socket.bound;

    // No fresh grant (unknown, consumed or expired), or a fresh one with
    // another key: the active pairing stays as it is.
    const expiring = await createGrant(f.fetch, host.accessToken);
    f.clock.tick(PAIRING_TTL_MS + 1);
    for (const code of ['ZZZZ-ZZZZ', first.code, expiring.code]) {
      assert.equal((await claimAsController(f.fetch, desktop, code)).status, 401);
    }
    const otherKey = await claimAsController(f.fetch, desktop, (await createGrant(f.fetch, host.accessToken)).code,
      await generateP256SigningKeyPair());
    assert.equal(otherKey.status, 401, 'another key cannot replace an active pairing');
    const borrowed = await f.fetch('/api/v1/pairings/claim', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: generateCanonicalId(),
      device_public_key: await exportPublicJwk(desktop.keys.publicKey),
      platform: 'macOS',
      user_agent: 'Browser',
      code: (await createGrant(f.fetch, host.accessToken)).code,
    }));
    assert.equal(borrowed.status, 401, 'another installation cannot take over the paired key');
    assert.ok(repos.keyAdmittedPairing(repos.getPairing(first.pairingId)));
    const staleChallenge = await (await f.fetch('/api/v1/sessions/device-challenge', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: desktop.browserId,
      host_id: host.hostId,
    }))).json() as { challenge_id: string };

    const claimed = await claimAsController(f.fetch, desktop, (await createGrant(f.fetch, host.accessToken)).code);
    assert.equal(claimed.status, 200);
    const second = await claimed.json() as { pairing_id: string; status: string };
    assert.equal(second.status, 'pending_confirmation');
    assert.notEqual(second.pairing_id, first.pairingId);
    // The claim ends the replaced pairing as a revoke would, but does not
    // record the key as revoked: the new pairing holds it.
    assert.ok([4001, 4003].includes(await socket.closed));
    assert.equal(repos.getPairing(first.pairingId), undefined);
    assert.equal(await ticketStatus(f.fetch, host.hostId, first.accessToken), 401);
    assert.equal(await refreshStatus(f.fetch, host.hostId, first.cookie), 401);
    assert.equal(repos.isRevokedPublicKey(publicKeyJwk, host.hostId), false);
    assert.equal(await deviceChallenge(f.fetch, host.hostId, desktop.browserId), 'DEVICE_NOT_PAIRED',
      'nothing is admitted before the Host confirms');

    assert.equal((await confirmPairing(f.fetch, second.pairing_id, host.accessToken)).status, 200);
    const stale = await f.fetch('/api/v1/sessions/device-login', post({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: desktop.browserId,
      host_id: host.hostId,
      challenge_id: staleChallenge.challenge_id,
      signature: await signChallenge(desktop.keys.privateKey, staleChallenge.challenge_id),
    }));
    assert.equal(stale.status, 401, 'a challenge of the replaced pairing does not log in to the new one');
    const relogin = await loginDevice(f.fetch, host.hostId, desktop.browserId, desktop.keys);
    assert.equal(relogin.body.device_id, second.pairing_id);
    assert.equal(await ticketStatus(f.fetch, host.hostId, relogin.body.access_token), 200);
    assert.equal(await ticketStatus(f.fetch, host.hostId, first.accessToken), 401);
  } finally {
    socket?.close();
    listened.close();
  }
});

test('after a Host revoke or a self-revoke, an admitted controller pairs its key again only through a fresh grant the Host confirms', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1_000 } });
  try {
    const repos = f.handle.services.repos;
    const host = await enrollHost(f.fetch);
    const phone = await enrollNativeController(f.fetch, 'iOS');
    const publicKeyJwk = JSON.stringify(await exportPublicJwk(phone.keys.publicKey));
    const first = await pairController(f.fetch, host, phone);

    assert.equal((await f.fetch(`/api/v1/host/devices/${first.pairingId}/revoke`, post({
      protocol: AUTH_PROTOCOL,
    }, host.accessToken))).status, 200);
    assert.equal(repos.isRevokedPublicKey(publicKeyJwk, host.hostId), true);
    assert.equal(await deviceChallenge(f.fetch, host.hostId, phone.browserId), 'DEVICE_REVOKED');
    f.clock.tick(1_000);

    // A claim the Host rejects pairs nothing, and its grant is spent.
    const rejectedGrant = await createGrant(f.fetch, host.accessToken);
    const pending = await claimAsController(f.fetch, phone, rejectedGrant.code);
    assert.equal(pending.status, 200);
    const pendingId = (await pending.json() as { pairing_id: string }).pairing_id;
    assert.equal(await deviceChallenge(f.fetch, host.hostId, phone.browserId), 'DEVICE_NOT_PAIRED');
    assert.equal((await f.fetch(`/api/v1/pairings/${pendingId}/confirm`, post({
      protocol: AUTH_PROTOCOL,
      pairing_id: pendingId,
      decision: 'reject',
    }, host.accessToken))).status, 200);
    assert.equal(await deviceChallenge(f.fetch, host.hostId, phone.browserId), 'DEVICE_NOT_PAIRED');
    assert.equal((await claimAsController(f.fetch, phone, rejectedGrant.code)).status, 401);

    const second = await pairController(f.fetch, host, phone);
    assert.notEqual(second.pairingId, first.pairingId);

    const signedAt = f.clock.now;
    const selfRevoke = await f.fetch(`/api/v1/hosts/${host.hostId}/pairing`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${second.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: AUTH_PROTOCOL,
        host_id: host.hostId,
        signed_at: signedAt,
        signature: await signBytes(phone.keys.privateKey, new TextEncoder().encode(selfRevokePayload({
          hostId: host.hostId,
          deviceId: second.pairingId,
          signedAt,
        }))),
      }),
    });
    assert.equal(selfRevoke.status, 200);
    f.handle.services.finalizeDeviceRevoke(host.hostId, second.pairingId);
    assert.equal(await deviceChallenge(f.fetch, host.hostId, phone.browserId), 'DEVICE_REVOKED');
    f.clock.tick(1_000);

    const third = await pairController(f.fetch, host, phone);
    for (const old of [first, second]) {
      assert.equal(repos.getPairing(old.pairingId), undefined);
      assert.equal(await ticketStatus(f.fetch, host.hostId, old.accessToken), 401);
      assert.equal(await refreshStatus(f.fetch, host.hostId, old.cookie), 401);
    }
    assert.equal(await ticketStatus(f.fetch, host.hostId, third.accessToken), 200);
    assert.equal(await refreshStatus(f.fetch, host.hostId, third.cookie), 200);
    // The revocation still covers what it revoked: a pairing of the key on
    // this Host created before it is refused.
    assert.equal(repos.keyAdmittedPairing({ ...repos.getPairing(third.pairingId)!, created_at: signedAt }), false);
  } finally { f.handle.shutdown(); }
});

test('a Host revoke of a pairing a re-pair replaced is done, and another Host still cannot revoke a pairing', async () => {
  const f = await makeRemoteTestApp({ config: { authRateLimitPerMinute: 1_000 } });
  try {
    const repos = f.handle.services.repos;
    const host = await enrollHost(f.fetch);
    const other = await enrollHost(f.fetch);
    const desktop = await enrollDesktopController(f.fetch);
    const first = await pairController(f.fetch, host, desktop);
    // Pairing the same key again replaces the first pairing and deletes its row.
    const second = await pairController(f.fetch, host, desktop);
    assert.equal(repos.getPairing(first.pairingId), undefined);
    const revoke = (deviceId: string, token?: string) =>
      f.fetch(`/api/v1/host/devices/${deviceId}/revoke`, post({ protocol: AUTH_PROTOCOL }, token));

    // The Host removing its record of the replaced pairing: nothing is left to
    // revoke, so the revocation is done, every time it is retried.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const settled = await revoke(first.pairingId, host.accessToken);
      assert.equal(settled.status, 200);
      assert.deepEqual(await settled.json(), {
        protocol: AUTH_PROTOCOL, host_id: host.hostId, device_id: first.pairingId, status: 'revoked',
      });
    }
    assert.equal(repos.getPairing(second.pairingId)?.revoked_at, null, 'the replacing pairing is untouched');
    assert.equal(await ticketStatus(f.fetch, host.hostId, second.accessToken), 200);

    // Another Host's pairing stays refused, and so does a call without a Host token.
    const foreign = await revoke(second.pairingId, other.accessToken);
    assert.equal(foreign.status, 401);
    assert.equal((await foreign.json() as { error: { code: string } }).error.code, 'DEVICE_NOT_PAIRED');
    assert.equal((await revoke(first.pairingId)).status, 401);
    assert.equal(repos.getPairing(second.pairingId)?.revoked_at, null);
    assert.equal(await ticketStatus(f.fetch, host.hostId, second.accessToken), 200);

    // Its own Host still revokes it.
    assert.equal((await revoke(second.pairingId, host.accessToken)).status, 200);
    assert.ok(repos.getPairing(second.pairingId)?.revoked_at);
    assert.equal(await ticketStatus(f.fetch, host.hostId, second.accessToken), 401);
  } finally { f.handle.shutdown(); }
});
