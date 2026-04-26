import { describe, expect, test } from 'bun:test';
import {
  extractBearer,
  generateToken,
  hashToken,
  unauthorizedResponse,
  verifyBearer,
} from '../src/server/auth.js';

describe('auth', () => {
  test('generateToken emits a token with the expected prefix and a matching hash', () => {
    const { token, hash } = generateToken();
    expect(token.startsWith('ll_agt_')).toBe(true);
    expect(token.length).toBeGreaterThan(20);
    expect(hash).toBe(hashToken(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('extractBearer handles Authorization header shapes', () => {
    const good = new Request('http://x/', { headers: { authorization: 'Bearer abc' } });
    expect(extractBearer(good)).toBe('abc');
    const empty = new Request('http://x/', { headers: { authorization: 'Bearer ' } });
    expect(extractBearer(empty)).toBeNull();
    const wrong = new Request('http://x/', { headers: { authorization: 'Basic abc' } });
    expect(extractBearer(wrong)).toBeNull();
    const none = new Request('http://x/');
    expect(extractBearer(none)).toBeNull();
  });

  test('verifyBearer accepts the matching token', () => {
    const { token, hash } = generateToken();
    const req = new Request('http://x/', { headers: { authorization: `Bearer ${token}` } });
    expect(verifyBearer(req, hash)).toBe(true);
  });

  test('verifyBearer rejects tampered token', () => {
    const { token, hash } = generateToken();
    const tampered = token.replace(/.$/, token.endsWith('a') ? 'b' : 'a');
    const req = new Request('http://x/', { headers: { authorization: `Bearer ${tampered}` } });
    expect(verifyBearer(req, hash)).toBe(false);
  });

  test('verifyBearer rejects missing bearer', () => {
    const req = new Request('http://x/');
    const { hash } = generateToken();
    expect(verifyBearer(req, hash)).toBe(false);
  });
});

describe('unauthorizedResponse', () => {
  test('status 401 with JSON body and content-type', async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="llamactl-agent"');
    const body = await res.json();
    expect(body).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'invalid bearer token' },
    });
  });

  test('accepts a custom message override', async () => {
    const res = unauthorizedResponse('token expired');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.message).toBe('token expired');
    expect(body.error.code).toBe('UNAUTHORIZED');
  });
});
