import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentAssetUrl,
  agentAssetShaUrl,
  fetchAgentRelease,
  isKnownAgentTarget,
  parseShaLine,
  type ArtifactFetcher,
} from '../src/infra/artifacts-fetch.js';

let dir = '';

const FAKE_BODY = new TextEncoder().encode('pretend-this-is-a-compiled-binary');
const FAKE_SHA = createHash('sha256').update(FAKE_BODY).digest('hex');

function stubFetcher(
  responses: Record<string, { ok: boolean; status: number; body: Uint8Array }>,
): { fetcher: ArtifactFetcher; calls: string[] } {
  const calls: string[] = [];
  const fetcher: ArtifactFetcher = async (url) => {
    calls.push(url);
    const r = responses[url];
    if (!r) {
      throw new Error(`unexpected url: ${url}`);
    }
    return {
      ok: r.ok,
      status: r.status,
      body: r.body,
      text: () => new TextDecoder().decode(r.body),
    };
  };
  return { fetcher, calls };
}

function latestResponse(tag: string): { ok: boolean; status: number; body: Uint8Array } {
  return {
    ok: true,
    status: 200,
    body: new TextEncoder().encode(JSON.stringify({ tag_name: tag })),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'llamactl-artifacts-fetch-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseShaLine', () => {
  test('standard shasum output: `<hex>  filename`', () => {
    const hex = 'a'.repeat(64);
    expect(parseShaLine(`${hex}  llamactl-agent-darwin-arm64`)).toBe(hex);
  });
  test('bare hex', () => {
    const hex = 'f'.repeat(64);
    expect(parseShaLine(hex)).toBe(hex);
  });
  test('rejects non-hex', () => {
    expect(parseShaLine('not-a-hash')).toBeNull();
    expect(parseShaLine('')).toBeNull();
    expect(parseShaLine('   ')).toBeNull();
  });
  test('lowercases the hex', () => {
    expect(parseShaLine('F'.repeat(64))).toBe('f'.repeat(64));
  });
});

describe('agentAssetUrl / agentAssetShaUrl', () => {
  test('constructs github release-download URLs', () => {
    expect(agentAssetUrl('frozename/llamactl', 'v0.4.0', 'darwin-arm64')).toBe(
      'https://github.com/frozename/llamactl/releases/download/v0.4.0/llamactl-agent-darwin-arm64',
    );
    expect(agentAssetShaUrl('frozename/llamactl', 'v0.4.0', 'linux-x64')).toBe(
      'https://github.com/frozename/llamactl/releases/download/v0.4.0/llamactl-agent-linux-x64.sha256',
    );
  });
});

describe('isKnownAgentTarget', () => {
  test('accepts the four supported platforms + rejects everything else', () => {
    expect(isKnownAgentTarget('darwin-arm64')).toBe(true);
    expect(isKnownAgentTarget('darwin-x64')).toBe(true);
    expect(isKnownAgentTarget('linux-x64')).toBe(true);
    expect(isKnownAgentTarget('linux-arm64')).toBe(true);
    expect(isKnownAgentTarget('windows-x64')).toBe(false);
    expect(isKnownAgentTarget('bsd-ppc64')).toBe(false);
  });
});

describe('fetchAgentRelease', () => {
  const REPO = 'frozename/llamactl';
  const TARGET = 'darwin-arm64';
  const TAG = 'v0.4.0';
  const BIN_URL = agentAssetUrl(REPO, TAG, TARGET);
  const SHA_URL = agentAssetShaUrl(REPO, TAG, TARGET);

  test('happy path: specific version + valid sha → writes binary + sha alongside', async () => {
    const { fetcher, calls } = stubFetcher({
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${FAKE_SHA}  llamactl-agent-${TARGET}\n`),
      },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(TAG);
    expect(result.target).toBe(TARGET);
    expect(result.bytes).toBe(FAKE_BODY.length);
    expect(result.sha256).toBe(FAKE_SHA);
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(result.path, 'utf8')).toContain('pretend-this-is-a-compiled-binary');
    // Executable bit set on Unix-ish platforms.
    const mode = statSync(result.path).mode & 0o777;
    expect(mode & 0o100).toBe(0o100);
    // Sha sidecar persisted for `shasum -c` re-verification.
    expect(existsSync(`${result.path}.sha256`)).toBe(true);
    // Skipped the latest-resolution API call.
    expect(calls.some((u) => u.includes('/releases/latest'))).toBe(false);
  });

  test('latest resolution: hits /releases/latest first, then the tagged asset URLs', async () => {
    const latestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
    const { fetcher, calls } = stubFetcher({
      [latestUrl]: latestResponse(TAG),
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${FAKE_SHA}\n`),
      },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: 'latest',
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBe(TAG);
    expect(calls[0]).toBe(latestUrl);
  });

  test('unknown target rejects with unknown-target', async () => {
    const { fetcher } = stubFetcher({});
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: 'windows-x64',
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown-target');
  });

  test('latest-API 404 → resolve-failed', async () => {
    const latestUrl = `https://api.github.com/repos/${REPO}/releases/latest`;
    const { fetcher } = stubFetcher({
      [latestUrl]: {
        ok: false,
        status: 404,
        body: new TextEncoder().encode('{"message":"Not Found"}'),
      },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: 'latest',
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('resolve-failed');
    expect(result.message).toContain('404');
  });

  test('missing binary asset → asset-missing, nothing written to disk', async () => {
    const { fetcher } = stubFetcher({
      [BIN_URL]: { ok: false, status: 404, body: new Uint8Array() },
      [SHA_URL]: { ok: true, status: 200, body: new TextEncoder().encode(FAKE_SHA) },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('asset-missing');
    expect(existsSync(join(dir, 'agent', TARGET, 'llamactl-agent'))).toBe(false);
  });

  test('sha mismatch → sha-mismatch, nothing written', async () => {
    const { fetcher } = stubFetcher({
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${'0'.repeat(64)}  llamactl-agent-${TARGET}\n`),
      },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('sha-mismatch');
    expect(result.message).toContain('expected 00000000');
    expect(result.message).toContain('got');
    expect(existsSync(join(dir, 'agent', TARGET, 'llamactl-agent'))).toBe(false);
  });

  test('malformed sha file content → download-failed (not sha-mismatch — distinct failure class)', async () => {
    const { fetcher } = stubFetcher({
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: { ok: true, status: 200, body: new TextEncoder().encode('<html>400</html>') },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('download-failed');
  });
});
