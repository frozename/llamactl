import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentBinaryPath,
  defaultArtifactsDir,
  handleArtifact,
  listArtifacts,
} from '../src/server/artifacts.js';

let dir = '';

function seedAgent(platform: string, body = 'fake-agent-binary'): string {
  const path = agentBinaryPath(platform, dir);
  mkdirSync(join(dir, 'agent', platform), { recursive: true });
  writeFileSync(path, body, 'utf8');
  return path;
}

async function call(
  pathname: string,
  method: 'GET' | 'HEAD' | 'POST' = 'GET',
): Promise<{ status: number; headers: Headers; body: string }> {
  const req = new Request(`http://agent${pathname}`, { method });
  const url = new URL(req.url);
  const res = handleArtifact(req, url, { artifactsDir: dir });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-artifacts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('handleArtifact', () => {
  test('GET /artifacts/agent/darwin-arm64 streams the binary when it exists', async () => {
    seedAgent('darwin-arm64', 'binary-bytes');
    const { status, headers, body } = await call('/artifacts/agent/darwin-arm64');
    expect(status).toBe(200);
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('content-length')).toBe('12');
    expect(headers.get('content-disposition')).toContain('llamactl-agent-darwin-arm64');
    expect(body).toBe('binary-bytes');
  });

  test('HEAD returns size + content-type without body', async () => {
    seedAgent('linux-x64', 'abcdefghij');
    const { status, headers, body } = await call('/artifacts/agent/linux-x64', 'HEAD');
    expect(status).toBe(200);
    expect(headers.get('content-length')).toBe('10');
    expect(body).toBe('');
  });

  test('missing binary returns 404 with a useful bun-build hint', async () => {
    const { status, body } = await call('/artifacts/agent/darwin-arm64');
    expect(status).toBe(404);
    expect(body).toContain('bun build --compile --target=bun-darwin-arm64');
    expect(body).toContain(agentBinaryPath('darwin-arm64', dir));
  });

  test('unsupported platform returns 404 (not 400 — matches not-found semantics)', async () => {
    const { status, body } = await call('/artifacts/agent/bsd-ppc64');
    expect(status).toBe(404);
    expect(body).toContain('unsupported platform');
  });

  test('malformed path returns 404', async () => {
    const { status } = await call('/artifacts/nope');
    expect(status).toBe(404);
  });

  test('POST returns 405', async () => {
    seedAgent('darwin-arm64');
    const { status } = await call('/artifacts/agent/darwin-arm64', 'POST');
    expect(status).toBe(405);
  });

  test('cache-control is a short public max-age', async () => {
    seedAgent('darwin-arm64');
    const { headers } = await call('/artifacts/agent/darwin-arm64');
    expect(headers.get('cache-control')).toBe('public, max-age=300');
  });
});

describe('listArtifacts', () => {
  test('enumerates every seeded platform, skips missing ones', () => {
    seedAgent('darwin-arm64', 'a');
    seedAgent('linux-x64', 'bbbb');
    const rows = listArtifacts(dir);
    const platforms = rows.map((r) => r.platform).sort();
    expect(platforms).toEqual(['darwin-arm64', 'linux-x64']);
    const mac = rows.find((r) => r.platform === 'darwin-arm64')!;
    expect(mac.sizeBytes).toBe(1);
    expect(mac.path).toBe(agentBinaryPath('darwin-arm64', dir));
  });

  test('empty dir yields empty list', () => {
    expect(listArtifacts(dir)).toEqual([]);
  });
});

describe('defaultArtifactsDir', () => {
  test('honors LLAMACTL_ARTIFACTS_DIR override', () => {
    expect(defaultArtifactsDir({ LLAMACTL_ARTIFACTS_DIR: '/custom/path' })).toBe('/custom/path');
  });

  test('falls back to DEV_STORAGE/artifacts', () => {
    expect(defaultArtifactsDir({ DEV_STORAGE: '/tmp/dev' })).toBe('/tmp/dev/artifacts');
  });
});
