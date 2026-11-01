import type { Hono } from 'hono';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_PROTOCOL,
  RemoteProtocolError,
  adminCreateEnrollmentRequestSchema,
  controllerChallengeRequestSchema,
  controllerEnrollmentClaimRequestSchema,
  controllerLoginRequestSchema,
  controllerMigrationChallengeRequestSchema,
  controllerMigrationLoginRequestSchema,
  controllerRevokeRequestSchema,
  identityFingerprint,
  parseClosed,
} from '@gian/remote-protocol';

import type { ServerIdentity } from './auth/identity.js';
import { verifyP256Signature } from './auth/signatures.js';
import type { TokenStore } from './auth/tokens.js';
import type { RemoteServerConfig } from './config.js';
import { hashSecret, hashesEqual, randomSecret } from './crypto-hash.js';
import type { RemoteRepositories } from './storage/repositories.js';

function errorBody(code: string) {
  return { protocol: AUTH_PROTOCOL, error: { code, message: code } };
}

export function installControllerEnrollmentRoutes(
  app: Hono,
  config: RemoteServerConfig,
  repos: RemoteRepositories,
  tokens: TokenStore,
  identity: ServerIdentity,
  closeUnauthorizedRoutes: () => void,
): void {
  const requireAdmin = (authorization: string | undefined): boolean => {
    const admin = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    return Boolean(admin) && hashesEqual(hashSecret(admin), hashSecret(config.adminToken));
  };
  const serverIdentity = {
    algorithm: 'P-256' as const,
    public_key: identity.publicJwk,
    fingerprint: identity.fingerprint,
  };

  app.post('/api/v1/admin/controller-enrollments', async context => {
    context.header('Cache-Control', 'no-store');
    if (!requireAdmin(context.req.header('authorization'))) return context.json(errorBody('AUTH_REQUIRED'), 401);
    const body = parseClosed(adminCreateEnrollmentRequestSchema, await context.req.json());
    void body.github_account_id;
    const token = randomSecret();
    const created = repos.createEnrollment(token, body.label);
    return context.json({
      protocol: AUTH_PROTOCOL,
      enrollment_id: created.id,
      enrollment_token: token,
      expires_at: created.expires_at,
    });
  });

  app.post('/api/v1/controller-enrollments/claim', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(controllerEnrollmentClaimRequestSchema, await context.req.json());
    await identityFingerprint(body.device_public_key);
    const claimed = repos.claimControllerEnrollment(body.enrollment_token, {
      browserInstallationId: body.browser_installation_id,
      publicKeyJwk: JSON.stringify(body.device_public_key),
      platform: body.platform,
    });
    if (claimed.status === 'invalid') return context.json(errorBody('AUTH_REQUIRED'), 401);
    if (claimed.status === 'consumed') return context.json(errorBody('ENROLLMENT_CONSUMED'), 409);
    if (claimed.status === 'expired') return context.json(errorBody('ENROLLMENT_EXPIRED'), 410);
    if (claimed.status === 'conflict') return context.json(errorBody('CONTROLLER_ALREADY_ADMITTED'), 409);
    if (claimed.status !== 'claimed') throw new Error('Unexpected controller enrollment result');
    return context.json({
      protocol: AUTH_PROTOCOL,
      browser_installation_id: claimed.device.browser_installation_id,
      server_identity: serverIdentity,
    });
  });

  app.post('/api/v1/sessions/controller-challenge', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(controllerChallengeRequestSchema, await context.req.json());
    const controller = repos.getController(body.browser_installation_id);
    if (controller?.revoked_at) return context.json(errorBody('CONTROLLER_REVOKED'), 401);
    if (!controller) return context.json(errorBody('CONTROLLER_NOT_ADMITTED'), 401);
    const challenge = randomSecret();
    const created = repos.createControllerChallenge(body.browser_installation_id, challenge, ACCESS_TOKEN_TTL_MS);
    return context.json({
      protocol: AUTH_PROTOCOL,
      challenge_id: created.id,
      challenge,
      expires_at: created.expires_at,
    });
  });

  app.post('/api/v1/sessions/controller-login', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(controllerLoginRequestSchema, await context.req.json());
    const controller = repos.getController(body.browser_installation_id);
    if (controller?.revoked_at) return context.json(errorBody('CONTROLLER_REVOKED'), 401);
    if (!controller) return context.json(errorBody('CONTROLLER_NOT_ADMITTED'), 401);
    const valid = await verifyP256Signature(JSON.parse(controller.public_key_jwk), body.challenge_id, body.signature);
    if (!valid || !repos.consumeControllerChallenge(body.challenge_id, body.browser_installation_id)) {
      return context.json(errorBody('AUTH_REQUIRED'), 401);
    }
    const access = tokens.issue({
      role: 'controller',
      hostId: body.browser_installation_id,
      installationId: body.browser_installation_id,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      controller_access_token: access.token,
      expires_at: access.expiresAt,
      browser_installation_id: body.browser_installation_id,
    });
  });

  app.post('/api/v1/controller-migrations/challenge', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(controllerMigrationChallengeRequestSchema, await context.req.json());
    const controller = repos.getController(body.browser_installation_id);
    if (controller?.revoked_at) return context.json(errorBody('CONTROLLER_REVOKED'), 401);
    if (controller) return context.json(errorBody('CONTROLLER_ALREADY_ADMITTED'), 409);
    const pairing = repos.getPairingByBrowserHost(body.browser_installation_id, body.host_id);
    if (!repos.keyAdmittedPairing(pairing)) {
      return context.json(errorBody(pairing?.revoked_at ? 'DEVICE_REVOKED' : 'DEVICE_NOT_PAIRED'), 401);
    }
    await identityFingerprint(body.device_public_key);
    if (repos.controllerKeyConflict(JSON.stringify(body.device_public_key), body.browser_installation_id)) {
      return context.json(errorBody('CONTROLLER_ALREADY_ADMITTED'), 409);
    }
    const challenge = randomSecret();
    const created = repos.createControllerMigrationChallenge({
      browserInstallationId: body.browser_installation_id,
      hostId: body.host_id,
      publicKeyJwk: JSON.stringify(body.device_public_key),
      challenge,
      ttlMs: ACCESS_TOKEN_TTL_MS,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      challenge_id: created.id,
      challenge,
      expires_at: created.expires_at,
    });
  });

  app.post('/api/v1/controller-migrations/login', async context => {
    context.header('Cache-Control', 'no-store');
    const body = parseClosed(controllerMigrationLoginRequestSchema, await context.req.json());
    const controller = repos.getController(body.browser_installation_id);
    if (controller?.revoked_at) return context.json(errorBody('CONTROLLER_REVOKED'), 401);
    if (controller) return context.json(errorBody('CONTROLLER_ALREADY_ADMITTED'), 409);
    const pairing = repos.getPairingByBrowserHost(body.browser_installation_id, body.host_id);
    if (!repos.keyAdmittedPairing(pairing)) {
      return context.json(errorBody(pairing?.revoked_at ? 'DEVICE_REVOKED' : 'DEVICE_NOT_PAIRED'), 401);
    }
    const migration = repos.getControllerMigrationChallenge(body.challenge_id);
    if (!migration || migration.browser_installation_id !== body.browser_installation_id || migration.host_id !== body.host_id
        || migration.used_at !== null) return context.json(errorBody('AUTH_REQUIRED'), 401);
    if (migration.expires_at <= config.now()) return context.json(errorBody('MIGRATION_CHALLENGE_EXPIRED'), 401);
    const valid = await verifyP256Signature(JSON.parse(pairing!.public_key_jwk), body.challenge_id, body.signature);
    if (!valid || !repos.consumeControllerMigration(body.challenge_id, body.browser_installation_id, body.host_id)) {
      return context.json(errorBody('AUTH_REQUIRED'), 401);
    }
    const access = tokens.issue({
      role: 'controller',
      hostId: body.browser_installation_id,
      installationId: body.browser_installation_id,
    });
    return context.json({
      protocol: AUTH_PROTOCOL,
      controller_access_token: access.token,
      expires_at: access.expiresAt,
      browser_installation_id: body.browser_installation_id,
    });
  });

  app.post('/api/v1/admin/controllers/:id/revoke', async context => {
    context.header('Cache-Control', 'no-store');
    if (!requireAdmin(context.req.header('authorization'))) return context.json(errorBody('AUTH_REQUIRED'), 401);
    parseClosed(controllerRevokeRequestSchema, await context.req.json());
    const browserInstallationId = context.req.param('id');
    if (!repos.getController(browserInstallationId)) throw new RemoteProtocolError('CONTROLLER_NOT_ADMITTED', 'controller required');
    repos.revokeController(browserInstallationId);
    tokens.revokeInstallation(browserInstallationId);
    closeUnauthorizedRoutes();
    return context.json({ protocol: AUTH_PROTOCOL, browser_installation_id: browserInstallationId, status: 'revoked' });
  });
}
