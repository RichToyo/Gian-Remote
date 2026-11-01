#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { serve } from '@hono/node-server';

import { hashEnrollmentPassword, isEnrollmentPasswordHash } from './auth/enrollment-password.js';
import { createRemoteApp, type RemoteAppHandle } from './app.js';
import { createConfig, parseEnrollmentGithubIds, type RemoteServerConfig } from './config.js';
import { createEnrollmentFromEnv } from './enrollment-command.js';

export interface RemoteServerListenOptions {
  host: string;
  port: number;
}

export interface StartedRemoteServer {
  handle: RemoteAppHandle;
  server: ReturnType<typeof serve>;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export function loadRemoteServerEnv(env: NodeJS.ProcessEnv = process.env): {
  config: RemoteServerConfig;
  listen: RemoteServerListenOptions;
} {
  const dataDir = required(env, 'GIAN_REMOTE_DATA_DIR');
  const publicOrigin = required(env, 'GIAN_REMOTE_PUBLIC_ORIGIN');
  const adminToken = required(env, 'GIAN_REMOTE_ADMIN_TOKEN');
  const staticDir = env.GIAN_REMOTE_STATIC_DIR?.trim();
  const host = env.GIAN_REMOTE_HOST?.trim() || '127.0.0.1';
  const port = parsePort(env.GIAN_REMOTE_PORT, 8787);
  const allowedOrigins = env.GIAN_REMOTE_ALLOWED_ORIGINS
    ? env.GIAN_REMOTE_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean)
    : [publicOrigin];
  return {
    config: createConfig({
      dataDir: resolve(dataDir),
      publicOrigin,
      adminToken,
      githubClientId: env.GIAN_REMOTE_GITHUB_CLIENT_ID?.trim() || undefined,
      enrollmentGithubIds: parseEnrollmentGithubIds(env.GIAN_REMOTE_ENROLLMENT_GITHUB_IDS),
      enrollmentPasswordHash: loadEnrollmentPasswordHash(env, resolve(dataDir)),
      allowedOrigins,
      ...(staticDir ? { staticDir: resolve(staticDir) } : {}),
      trustedProxy: env.GIAN_REMOTE_TRUSTED_PROXY === '1',
      version: env.GIAN_REMOTE_VERSION?.trim() || '1.0.0',
      buildId: env.GIAN_REMOTE_BUILD_ID?.trim() || 'dev',
    }),
    listen: { host, port },
  };
}

export async function startRemoteServer(input: {
  config: RemoteServerConfig;
  listen: RemoteServerListenOptions;
}): Promise<StartedRemoteServer> {
  const handle = await createRemoteApp(input.config);
  const server = serve({
    fetch: handle.app.fetch,
    hostname: input.listen.host,
    port: input.listen.port,
  });
  handle.injectWebSocket(server);
  await new Promise<void>((resolveListening, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    if (server.listening) {
      server.off('error', onError);
      resolveListening();
      return;
    }
    server.once('listening', () => {
      server.off('error', onError);
      resolveListening();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : input.listen.port;
  const url = `http://${input.listen.host}:${port}`;
  return {
    handle,
    server,
    host: input.listen.host,
    port,
    url,
    async close() {
      handle.shutdown();
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<StartedRemoteServer> {
  const loaded = loadRemoteServerEnv(env);
  const started = await startRemoteServer(loaded);
  process.stdout.write(`gian-remote-server listening ${started.url}\n`);
  const shutdown = () => {
    void started.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return started;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/** Env wins only when it matches the 0600 file. A missing hash disables page issuance. */
export function loadEnrollmentPasswordHash(env: NodeJS.ProcessEnv, dataDir: string): string | undefined {
  const fromEnv = env.GIAN_REMOTE_ENROLLMENT_PASSWORD_HASH?.trim() || undefined;
  const filePath = resolve(dataDir, 'enrollment-password.hash');
  let fromFile: string | undefined;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error('enrollment-password.hash must be a regular file');
    if ((stat.mode & 0o077) !== 0) throw new Error('enrollment-password.hash must be mode 0600');
    fromFile = readFileSync(filePath, 'utf8').trim() || undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (fromEnv && fromFile && fromEnv !== fromFile) {
    throw new Error('GIAN_REMOTE_ENROLLMENT_PASSWORD_HASH and enrollment-password.hash disagree');
  }
  const value = fromEnv ?? fromFile;
  if (!value) return undefined;
  if (!isEnrollmentPasswordHash(value)) throw new Error('enrollment password hash is not a supported scrypt verifier');
  return value;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('GIAN_REMOTE_PORT must be an integer 0-65535');
  }
  return port;
}

const invoked = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
export async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (args.length === 0) { await main(env); return; }
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    process.stdout.write('Usage: gian-remote-server [enrollment create [--label NAME] [--account-id GITHUB_ID] | enrollment create-controller [--label NAME] | enrollment password-hash]\nRun enrollment create or create-controller inside the running server container/service environment. Both issue the same one-time native client admission code.\npassword-hash reads one password from stdin and prints only the scrypt verifier.\n');
    return;
  }
  if (args[0] === 'enrollment' && args[1] === 'password-hash') {
    if (args.length !== 2) throw new Error('Usage: gian-remote-server enrollment password-hash');
    const password = (await readStdin()).replace(/\r?\n$/, '');
    process.stdout.write(`${await hashEnrollmentPassword(password)}\n`);
    return;
  }
  if (args[0] !== 'enrollment' || !['create', 'create-controller'].includes(args[1] ?? '')) {
    throw new Error('Usage: gian-remote-server enrollment create [--label NAME] [--account-id GITHUB_ID] or enrollment create-controller [--label NAME]');
  }
  const { values } = parseArgs({ args: args.slice(2), options: { label: { type: 'string' }, 'account-id': { type: 'string' } } });
  const issued = await createEnrollmentFromEnv(env, values.label, fetch, values['account-id']);
  process.stdout.write(`Server URL: ${issued.server_url}\nEnrollment token: ${issued.enrollment_token}\nExpires at: ${issued.expires_at}\nUse once in Gian macOS or iOS before expiry.\n`);
}

function readStdin(): Promise<string> {
  return new Promise((resolveStdin, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolveStdin(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}
if (invoked) {
  void runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
