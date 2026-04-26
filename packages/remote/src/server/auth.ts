import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Bearer token auth for the node agent. The agent stores only the
 * SHA-256 hash of the token on disk; the plaintext is shown once at
 * `agent init` time and must be transmitted out-of-band (via the
 * bootstrap blob). Every request carries `Authorization: Bearer <tok>`,
 * which the agent hashes and constant-time-compares to the stored
 * digest.
 */

export function generateToken(): { token: string; hash: string } {
  const token = `ll_agt_${randomBytes(24).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  if (!h.startsWith('Bearer ')) return null;
  const rest = h.slice('Bearer '.length).trim();
  return rest.length > 0 ? rest : null;
}

export function verifyBearer(req: Request, expectedHashHex: string): boolean {
  const token = extractBearer(req);
  if (!token) return false;
  const actualHex = hashToken(token);
  if (actualHex.length !== expectedHashHex.length) return false;
  return timingSafeEqual(Buffer.from(actualHex, 'hex'), Buffer.from(expectedHashHex, 'hex'));
}

/**
 * Standard 401 response for any authed endpoint that fails bearer
 * verification. JSON body + content-type lets tRPC/HTTP clients parse
 * a clean error envelope instead of throwing "Failed to parse JSON" on
 * a bare-string body. Shape is stable so client-side recognizers can
 * key off `error.code === 'UNAUTHORIZED'`.
 */
export function unauthorizedResponse(message: string = 'invalid bearer token'): Response {
  return new Response(
    JSON.stringify({ error: { code: 'UNAUTHORIZED', message } }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="llamactl-agent"',
      },
    },
  );
}
