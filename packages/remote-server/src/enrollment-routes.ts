import type { Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  AUTH_PROTOCOL, RemoteProtocolError, adminCreateEnrollmentRequestSchema, enrollmentPasswordLoginRequestSchema,
  parseClosed,
} from '@gian/remote-protocol';
import type { RemoteServerConfig } from './config.js';
import type { RemoteRepositories } from './storage/repositories.js';
import { hashSecret, hashesEqual, randomSecret } from './crypto-hash.js';
import { verifyEnrollmentPassword } from './auth/enrollment-password.js';
import { SlidingWindowLimiter } from './auth/rate-limit.js';

const SESSION_COOKIE = 'gian_remote_enrollment';
const CSRF_COOKIE = 'gian_remote_enrollment_csrf';
const PATH = '/api/v1/enrollment';
const SESSION_TTL = 60 * 60 * 1000;
const PASSWORD_FAILURES = 5;
const PASSWORD_WINDOW_MS = 15 * 60 * 1000;

/** Issuance session for the deployer password. It is not a device credential
 * and not the deployment admin token. */
export function installEnrollmentRoutes(app: Hono, config: RemoteServerConfig,
  repos: RemoteRepositories): () => void {
  const cookieOptions = { path: PATH, secure: true, httpOnly: true, sameSite: 'Strict' as const };
  const failures = new SlidingWindowLimiter(config.now, PASSWORD_FAILURES, PASSWORD_WINDOW_MS);
  const clientKey = (forwarded: string | undefined) => {
    if (config.trustedProxy && forwarded) return forwarded.split(',')[0]?.trim() || 'unknown';
    return 'direct';
  };
  const csrfCookie = (token: string) => hashSecret(token);
  const requireCsrf = (header: string | undefined, cookie: string | undefined) => {
    if (!header || header.length > 256 || !cookie || !hashesEqual(hashSecret(header), cookie)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment csrf required');
    }
  };
  const requireSession = (token: string | undefined) => {
    const generation = config.enrollmentPasswordHash ? hashSecret(config.enrollmentPasswordHash) : '';
    if (!token || token.length > 256 || !generation) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment login required');
    }
    const row = repos.db.prepare(`SELECT password_generation FROM enrollment_password_sessions
      WHERE token_hash = ? AND expires_at > ?`).get(hashSecret(token), config.now()) as { password_generation: string } | undefined;
    if (!row || !hashesEqual(row.password_generation, generation)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'enrollment login required');
    }
  };
  app.use(`${PATH}/*`, async (context, next) => {
    context.header('Cache-Control', 'no-store');
    if (context.req.method !== 'GET' && !config.allowedOrigins.includes(context.req.header('origin') ?? '')) {
      return context.json({ error: { code: 'AUTH_REQUIRED' } }, 403);
    }
    await next();
  });
  app.get(`${PATH}/csrf`, context => {
    const token = randomSecret();
    setCookie(context, CSRF_COOKIE, csrfCookie(token), cookieOptions);
    return context.json({ protocol: AUTH_PROTOCOL, csrf_token: token });
  });
  app.post(`${PATH}/login`, async context => {
    const ip = clientKey(context.req.header('x-forwarded-for'));
    const failureKey = `login:${ip}`;
    if (failures.blocked(failureKey)) return context.json({ error: { code: 'RATE_LIMITED' } }, 429);
    if (!config.enrollmentPasswordHash) return context.json({ error: { code: 'ENROLLMENT_DISABLED' } }, 403);
    try { requireCsrf(context.req.header('x-gian-csrf'), getCookie(context, CSRF_COOKIE)); }
    catch {
      failures.record(failureKey);
      return context.json({ error: { code: 'AUTH_REQUIRED' } }, 403);
    }
    const body = parseClosed(enrollmentPasswordLoginRequestSchema, await context.req.json());
    // The deployment admin token is not the page password, even if a deployer
    // stored a verifier for that same string.
    const presentedAdmin = hashesEqual(hashSecret(body.password), hashSecret(config.adminToken));
    const matches = !presentedAdmin && await verifyEnrollmentPassword(body.password, config.enrollmentPasswordHash);
    if (!matches) {
      failures.record(failureKey);
      return context.json({ error: { code: 'AUTH_REQUIRED' } }, 401);
    }
    const token = randomSecret();
    const generation = hashSecret(config.enrollmentPasswordHash);
    repos.db.prepare('DELETE FROM enrollment_password_sessions WHERE expires_at <= ?').run(config.now());
    repos.db.prepare(`INSERT INTO enrollment_password_sessions(token_hash, password_generation, expires_at)
      VALUES (?, ?, ?)`).run(hashSecret(token), generation, config.now() + SESSION_TTL);
    setCookie(context, SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL / 1000 });
    return context.json({ protocol: AUTH_PROTOCOL, ok: true });
  });
  app.get(`${PATH}/session`, context => {
    requireSession(getCookie(context, SESSION_COOKIE));
    return context.json({ protocol: AUTH_PROTOCOL, ok: true });
  });
  app.post(`${PATH}/logout`, context => {
    try { requireCsrf(context.req.header('x-gian-csrf'), getCookie(context, CSRF_COOKIE)); }
    catch { return context.json({ error: { code: 'AUTH_REQUIRED' } }, 403); }
    const token = getCookie(context, SESSION_COOKIE);
    if (token) repos.db.prepare('DELETE FROM enrollment_password_sessions WHERE token_hash = ?').run(hashSecret(token));
    deleteCookie(context, SESSION_COOKIE, cookieOptions);
    return context.json({ ok: true });
  });
  const mint = async (context: Context) => {
    try { requireCsrf(context.req.header('x-gian-csrf'), getCookie(context, CSRF_COOKIE)); }
    catch { return context.json({ error: { code: 'AUTH_REQUIRED' } }, 403); }
    requireSession(getCookie(context, SESSION_COOKIE));
    const body = parseClosed(adminCreateEnrollmentRequestSchema, await context.req.json());
    // github_account_id is accepted so older page clients still parse, and ignored.
    void body.github_account_id;
    const token = randomSecret();
    const created = repos.createEnrollment(token, body.label);
    return context.json({ protocol: AUTH_PROTOCOL, enrollment_id: created.id,
      enrollment_token: token, expires_at: created.expires_at });
  };
  app.post(`${PATH}/tokens`, mint);
  app.post(`${PATH}/controller-tokens`, mint);
  return () => {};
}
