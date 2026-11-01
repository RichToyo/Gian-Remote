import { discoverServerIdentity, RemoteProtocolError } from '@gian/remote-protocol';

/** Server pin for this browser profile. It is not a device key and not a GitHub session. */
export const SERVER_PIN_KEY = 'gian.remote.server_identity_fingerprint';

export function serverPinStorageKey(serverOrigin: string): string {
  return `${SERVER_PIN_KEY}:${encodeURIComponent(serverOrigin)}`;
}

export function readServerIdentityPin(serverOrigin?: string): string | null {
  const storage = globalThis.localStorage;
  if (!storage) return null;
  const scoped = serverOrigin ? storage.getItem(serverPinStorageKey(serverOrigin)) : null;
  const value = serverOrigin ? scoped : storage.getItem(SERVER_PIN_KEY);
  if (serverOrigin && !scoped && storage.getItem(SERVER_PIN_KEY)) {
    // The legacy row has no origin evidence. Never guess that it belongs to
    // this Desktop Server, delete it, or copy it into a new scope.
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity pin scope is unassigned');
  }
  if (!value) return null;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity pin storage unavailable');
  }
  return value;
}

export function writeServerIdentityPin(fingerprint: string, serverOrigin?: string): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity pin storage unavailable');
  const key = serverOrigin ? serverPinStorageKey(serverOrigin) : SERVER_PIN_KEY;
  storage.setItem(key, fingerprint);
  if (storage.getItem(key) !== fingerprint) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity pin storage unavailable');
  }
}

/** Fetch and verify POST /api/v1/server-identity, then keep the first fingerprint.
 * A later fingerprint is rejected and the saved pin is left unchanged.
 * The signature does not create a trust anchor independent of TLS. */
export async function pinDiscoveredServer(input: {
  origin: string;
  storageScope?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<string> {
  const pinned = readServerIdentityPin(input.storageScope);
  const discovered = await discoverServerIdentity({
    origin: input.origin,
    fetchFn: input.fetchFn,
    now: input.now,
    pinnedFingerprint: pinned,
  });
  writeServerIdentityPin(discovered.fingerprint, input.storageScope);
  return discovered.fingerprint;
}

export function identityPinRejected(error: unknown): boolean {
  return error instanceof RemoteProtocolError && (
    error.message === 'server identity changed'
    || error.message === 'server identity pin scope is unassigned'
    || error.message === 'server identity proof rejected'
  );
}
