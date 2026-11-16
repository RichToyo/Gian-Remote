import { isIP } from 'node:net';

import type { RemoteServerConfig } from '../config.js';

interface AddressedRequest {
  env?: unknown;
  req: { header(name: string): string | undefined };
}

/** The client address rate limits key on.
 *
 *  Exposed directly, it is the TCP peer of the request socket. Behind
 *  GIAN_REMOTE_TRUSTED_PROXY it is the last X-Forwarded-For entry, the one
 *  the single trusted proxy appended for the peer it accepted; every entry
 *  left of it came from the client. An in-process request without a socket
 *  gets 'unknown'. */
export function clientAddress(config: Pick<RemoteServerConfig, 'trustedProxy'>, context: AddressedRequest): string {
  if (config.trustedProxy) {
    const appended = context.req.header('x-forwarded-for')?.split(',').map((entry) => entry.trim())
      .filter(Boolean).at(-1);
    const address = appended ? normalizeAddress(appended) : undefined;
    if (address) return address;
  }
  // @hono/node-server passes the Node request as env.incoming.
  const peer = (context.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return (peer && normalizeAddress(peer)) || 'unknown';
}

/** A bare IP, without a port, brackets or the IPv4-mapped IPv6 prefix. */
function normalizeAddress(value: string): string | undefined {
  const bare = /^\[([^\]]+)\](?::\d+)?$/.exec(value)?.[1]
    ?? /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(value)?.[1]
    ?? value;
  if (!isIP(bare)) return undefined;
  return (/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bare)?.[1] ?? bare).toLowerCase();
}
