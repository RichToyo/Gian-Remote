import {
  AUTH_PROTOCOL,
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  serverIdentityProofPayload,
  signBytes,
} from '@gian/remote-protocol';

let keys: CryptoKeyPair | undefined;
let fingerprint = '';

/** Stable proof responder for controller tests. The key is fixed for this module instance. */
export async function serverIdentityFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.includes('/api/v1/server-identity')) return new Response('not found', { status: 404 });
  if (!keys) {
    keys = await generateP256SigningKeyPair();
    fingerprint = await identityFingerprint(await exportPublicJwk(keys.publicKey));
  }
  const body = JSON.parse(String(init?.body ?? '{}')) as { nonce?: string };
  const publicKey = await exportPublicJwk(keys.publicKey);
  const expiresAt = Date.now() + 120_000;
  const payload = serverIdentityProofPayload({
    nonce: body.nonce ?? '',
    fingerprint,
    expires_at: expiresAt,
  });
  return Response.json({
    protocol: AUTH_PROTOCOL,
    server_identity: { algorithm: 'P-256', public_key: publicKey, fingerprint },
    expires_at: expiresAt,
    signature: await signBytes(keys.privateKey, new TextEncoder().encode(payload)),
  });
}
