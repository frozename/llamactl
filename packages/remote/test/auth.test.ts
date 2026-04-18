import { describe, expect, test } from 'bun:test';
import { extractBearer, generateToken, hashToken, verifyBearer } from '../src/server/auth.js';

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
