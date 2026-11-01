import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** scrypt$N$r$p$salt$key — deployer-supplied verifier, never a default password. */
export function isEnrollmentPasswordHash(value: string): boolean {
  return parseEnrollmentPasswordHash(value) !== undefined;
}

export async function hashEnrollmentPassword(password: string): Promise<string> {
  if (password.length < 1 || password.length > 256) {
    throw new Error('Enrollment password must be 1-256 characters');
  }
  const salt = randomBytes(16);
  const derived = await derive(password, salt, N, R, P);
  return formatHash(salt, derived);
}

export async function verifyEnrollmentPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseEnrollmentPasswordHash(stored);
  if (!parsed || password.length < 1 || password.length > 256) return false;
  const derived = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p);
  if (derived.length !== parsed.key.length) return false;
  return timingSafeEqual(derived, parsed.key);
}

function formatHash(salt: Buffer, key: Buffer): string {
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

function parseEnrollmentPasswordHash(value: string): {
  N: number; r: number; p: number; salt: Buffer; key: Buffer;
} | undefined {
  const parts = value.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return undefined;
  const cost = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (cost !== N || r !== R || p !== P) return undefined;
  const salt = decode(parts[4] ?? '');
  const key = decode(parts[5] ?? '');
  if (!salt || salt.length !== 16 || !key || key.length !== KEYLEN) return undefined;
  return { N: cost, r, p, salt, key };
}

function decode(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length > 0 ? bytes : undefined;
}

function derive(password: string, salt: Buffer, cost: number, r: number, p: number): Promise<Buffer> {
  return scrypt(password, salt, KEYLEN, { N: cost, r, p, maxmem: 64 * 1024 * 1024 }) as Promise<Buffer>;
}
