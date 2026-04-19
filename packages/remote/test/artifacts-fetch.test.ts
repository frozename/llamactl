import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  agentAssetCertUrl,
  agentAssetShaUrl,
  agentAssetSigUrl,
  agentAssetUrl,
  agentVersionDir,
  cosignIdentityRegex,
  fetchAgentRelease,
  isKnownAgentTarget,
  listAgentVersions,
  parseShaLine,
  pruneAgentArtifacts,
  type ArtifactFetcher,
  type CosignVerifier,
} from '../src/infra/artifacts-fetch.js';
import { lstatSync, mkdirSync, utimesSync, writeFileSync as writeFileSyncNode } from 'node:fs';
import { agentBinaryPath } from '../src/server/artifacts.js';

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

describe('cosignIdentityRegex', () => {
  test('escapes dots + encodes workflow path for the repo', () => {
    const r = cosignIdentityRegex('frozename/llamactl');
    expect(r).toBe(
      '^https://github\\.com/frozename/llamactl/\\.github/workflows/release-agent\\.yml@refs/tags/v.+$',
    );
    // Sanity: the regex actually matches a plausible cosign cert identity.
    const re = new RegExp(r);
    expect(re.test('https://github.com/frozename/llamactl/.github/workflows/release-agent.yml@refs/tags/v0.4.2')).toBe(true);
    expect(re.test('https://github.com/other/repo/.github/workflows/release-agent.yml@refs/tags/v0.4.2')).toBe(false);
    expect(re.test('https://github.com/frozename/llamactl/.github/workflows/release-agent.yml@refs/heads/main')).toBe(false);
  });
});

describe('fetchAgentRelease — cosign signature verification (I.5.3)', () => {
  const REPO = 'frozename/llamactl';
  const TARGET = 'darwin-arm64';
  const TAG = 'v0.4.0';
  const BIN_URL = agentAssetUrl(REPO, TAG, TARGET);
  const SHA_URL = agentAssetShaUrl(REPO, TAG, TARGET);
  const SIG_URL = agentAssetSigUrl(REPO, TAG, TARGET);
  const CERT_URL = agentAssetCertUrl(REPO, TAG, TARGET);

  function baseResponses(): Record<string, { ok: boolean; status: number; body: Uint8Array }> {
    return {
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${FAKE_SHA}  llamactl-agent-${TARGET}\n`),
      },
    };
  }

  test('default (verifySig omitted) returns signature.verified=null and skips the sig fetch entirely', async () => {
    const { fetcher, calls } = stubFetcher(baseResponses());
    let cosignCalls = 0;
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      cosignVerifier: async () => {
        cosignCalls++;
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature.verified).toBeNull();
    expect(result.signature.reason).toMatch(/skipped/);
    expect(cosignCalls).toBe(0);
    expect(calls.some((u) => u.endsWith('.sig'))).toBe(false);
    expect(calls.some((u) => u.endsWith('.cert'))).toBe(false);
  });

  test('best-effort with missing .sig → verified=null, ok=true (download still succeeds)', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: false, status: 404, body: new Uint8Array() };
    responses[CERT_URL] = { ok: false, status: 404, body: new Uint8Array() };
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'best-effort',
      cosignVerifier: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature.verified).toBeNull();
    expect(result.signature.reason).toMatch(/signature assets missing/);
  });

  test('best-effort with cosign success → verified=true, .sig + .cert written alongside', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: true, status: 200, body: new TextEncoder().encode('sig-bytes') };
    responses[CERT_URL] = { ok: true, status: 200, body: new TextEncoder().encode('cert-bytes') };
    const cosignCalls: Parameters<CosignVerifier>[0][] = [];
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'best-effort',
      cosignVerifier: async (input) => {
        cosignCalls.push(input);
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature.verified).toBe(true);
    expect(cosignCalls).toHaveLength(1);
    expect(cosignCalls[0]!.repo).toBe(REPO);
    expect(cosignCalls[0]!.tag).toBe(TAG);
    // Verifier was handed paths, not bytes — confirm the files exist.
    expect(existsSync(cosignCalls[0]!.sigPath)).toBe(true);
    expect(existsSync(cosignCalls[0]!.certPath)).toBe(true);
    expect(readFileSync(cosignCalls[0]!.sigPath, 'utf8')).toBe('sig-bytes');
  });

  test('best-effort with cosign failure → verified=false, ok=true (download kept; operator decides)', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: true, status: 200, body: new TextEncoder().encode('sig') };
    responses[CERT_URL] = { ok: true, status: 200, body: new TextEncoder().encode('cert') };
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'best-effort',
      cosignVerifier: async () => ({ ok: false, message: 'fake cosign mismatch' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature.verified).toBe(false);
    expect(result.signature.reason).toBe('fake cosign mismatch');
  });

  test('require mode + missing sig → sig-verify-failed, fetch fails loudly', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: false, status: 404, body: new Uint8Array() };
    responses[CERT_URL] = { ok: false, status: 404, body: new Uint8Array() };
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'require',
      cosignVerifier: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('sig-verify-failed');
    expect(result.message).toMatch(/signature assets missing/);
  });

  test('require mode + cosign mismatch → sig-verify-failed', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: true, status: 200, body: new TextEncoder().encode('s') };
    responses[CERT_URL] = { ok: true, status: 200, body: new TextEncoder().encode('c') };
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'require',
      cosignVerifier: async () => ({ ok: false, message: 'bad cert' }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('sig-verify-failed');
    expect(result.message).toContain('bad cert');
  });

  test('require mode + cosign success → ok + verified=true', async () => {
    const responses = baseResponses();
    responses[SIG_URL] = { ok: true, status: 200, body: new TextEncoder().encode('s') };
    responses[CERT_URL] = { ok: true, status: 200, body: new TextEncoder().encode('c') };
    const { fetcher } = stubFetcher(responses);
    const result = await fetchAgentRelease({
      repo: REPO,
      version: TAG,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
      verifySig: 'require',
      cosignVerifier: async () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.signature.verified).toBe(true);
  });
});

describe('fetchAgentRelease — versioned layout (I.5.4)', () => {
  const REPO = 'frozename/llamactl';
  const TARGET = 'darwin-arm64';
  const TAG = 'v0.4.0';
  const BIN_URL = agentAssetUrl(REPO, TAG, TARGET);
  const SHA_URL = agentAssetShaUrl(REPO, TAG, TARGET);

  test('writes binary into versions/<tag>/ and symlinks the top-level path', async () => {
    const { fetcher } = stubFetcher({
      [BIN_URL]: { ok: true, status: 200, body: FAKE_BODY },
      [SHA_URL]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(`${FAKE_SHA}\n`),
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
    const versionedBin = join(agentVersionDir(TARGET, TAG, dir), 'llamactl-agent');
    expect(result.path).toBe(versionedBin);
    expect(existsSync(versionedBin)).toBe(true);
    expect(existsSync(`${versionedBin}.sha256`)).toBe(true);

    const topLevel = join(dir, 'agent', TARGET, 'llamactl-agent');
    expect(existsSync(topLevel)).toBe(true);
    const stat = lstatSync(topLevel);
    expect(stat.isSymbolicLink()).toBe(true);
  });

  test('sanitizes unsafe characters in the version tag', async () => {
    const weirdTag = 'v0.4.0/../escape';
    const { fetcher } = stubFetcher({
      [agentAssetUrl(REPO, weirdTag, TARGET)]: {
        ok: true,
        status: 200,
        body: FAKE_BODY,
      },
      [agentAssetShaUrl(REPO, weirdTag, TARGET)]: {
        ok: true,
        status: 200,
        body: new TextEncoder().encode(FAKE_SHA),
      },
    });
    const result = await fetchAgentRelease({
      repo: REPO,
      version: weirdTag,
      target: TARGET,
      artifactsDir: dir,
      fetcher,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const versionedDir = agentVersionDir(TARGET, weirdTag, dir);
    expect(versionedDir).toContain('v0.4.0_.._escape');
    expect(existsSync(result.path)).toBe(true);
    // No file landed two levels up.
    expect(existsSync(join(dir, 'agent', 'llamactl-agent'))).toBe(false);
  });

  test('second fetch at a new tag moves the symlink without deleting the old version', async () => {
    const TAG2 = 'v0.5.0';
    const SHA2 = createHash('sha256').update(FAKE_BODY).digest('hex');
    const { fetcher } = stubFetcher({
      [agentAssetUrl(REPO, TAG, TARGET)]: { ok: true, status: 200, body: FAKE_BODY },
      [agentAssetShaUrl(REPO, TAG, TARGET)]: {
        ok: true, status: 200,
        body: new TextEncoder().encode(FAKE_SHA),
      },
      [agentAssetUrl(REPO, TAG2, TARGET)]: { ok: true, status: 200, body: FAKE_BODY },
      [agentAssetShaUrl(REPO, TAG2, TARGET)]: {
        ok: true, status: 200,
        body: new TextEncoder().encode(SHA2),
      },
    });
    await fetchAgentRelease({ repo: REPO, version: TAG, target: TARGET, artifactsDir: dir, fetcher });
    await fetchAgentRelease({ repo: REPO, version: TAG2, target: TARGET, artifactsDir: dir, fetcher });
    const oldVersioned = join(agentVersionDir(TARGET, TAG, dir), 'llamactl-agent');
    const newVersioned = join(agentVersionDir(TARGET, TAG2, dir), 'llamactl-agent');
    expect(existsSync(oldVersioned)).toBe(true);
    expect(existsSync(newVersioned)).toBe(true);
  });
});

describe('listAgentVersions + pruneAgentArtifacts (I.5.4)', () => {
  const TARGET = 'darwin-arm64';

  function seedVersion(tag: string, mtimeMs?: number): string {
    const vdir = agentVersionDir(TARGET, tag, dir);
    mkdirSync(vdir, { recursive: true });
    const bin = join(vdir, 'llamactl-agent');
    writeFileSyncNode(bin, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    if (mtimeMs !== undefined) {
      const s = mtimeMs / 1000;
      utimesSync(bin, s, s);
    }
    return bin;
  }

  test('listAgentVersions returns zero entries on an empty dir', () => {
    expect(listAgentVersions({ artifactsDir: dir })).toEqual([]);
  });

  test('listAgentVersions enumerates each versioned binary + flags the active symlink', () => {
    const a = seedVersion('v0.4.0', Date.now() - 3 * 86400_000);
    const b = seedVersion('v0.5.0', Date.now() - 2 * 86400_000);
    seedVersion('v0.6.0', Date.now() - 1 * 86400_000);
    // Link v0.5.0 as active.
    const topLevel = agentBinaryPath(TARGET, dir);
    mkdirSync(join(dir, 'agent', TARGET), { recursive: true });
    void a;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').symlinkSync(b, topLevel);

    const versions = listAgentVersions({ artifactsDir: dir });
    expect(versions.map((v) => v.tag).sort()).toEqual(['v0.4.0', 'v0.5.0', 'v0.6.0']);
    const active = versions.find((v) => v.active);
    expect(active?.tag).toBe('v0.5.0');
  });

  test('prune keeps the newest N by mtime and flags the rest', () => {
    seedVersion('v0.1.0', Date.now() - 5 * 86400_000);
    seedVersion('v0.2.0', Date.now() - 4 * 86400_000);
    seedVersion('v0.3.0', Date.now() - 3 * 86400_000);
    seedVersion('v0.4.0', Date.now() - 2 * 86400_000);
    seedVersion('v0.5.0', Date.now() - 1 * 86400_000);

    const plan = pruneAgentArtifacts({
      artifactsDir: dir,
      target: TARGET,
      keep: 3,
    });
    expect(plan.executed).toBe(false);
    expect(plan.candidates.map((c) => c.tag).sort()).toEqual(['v0.1.0', 'v0.2.0']);
    // Dry-run: files still present.
    expect(existsSync(agentVersionDir(TARGET, 'v0.1.0', dir))).toBe(true);
  });

  test('--execute removes the flagged versions from disk', () => {
    seedVersion('v0.1.0', Date.now() - 4 * 86400_000);
    seedVersion('v0.2.0', Date.now() - 3 * 86400_000);
    seedVersion('v0.3.0', Date.now() - 2 * 86400_000);

    const result = pruneAgentArtifacts({
      artifactsDir: dir,
      target: TARGET,
      keep: 1,
      execute: true,
    });
    expect(result.executed).toBe(true);
    expect(result.removed.map((r) => r.tag).sort()).toEqual(['v0.1.0', 'v0.2.0']);
    expect(existsSync(agentVersionDir(TARGET, 'v0.1.0', dir))).toBe(false);
    expect(existsSync(agentVersionDir(TARGET, 'v0.2.0', dir))).toBe(false);
    expect(existsSync(agentVersionDir(TARGET, 'v0.3.0', dir))).toBe(true);
  });

  test('prune never removes the active version even when it falls outside the keep window', () => {
    // Seed three versions, with the OLDEST being the active one.
    const oldest = seedVersion('v0.1.0', Date.now() - 5 * 86400_000);
    seedVersion('v0.2.0', Date.now() - 3 * 86400_000);
    seedVersion('v0.3.0', Date.now() - 1 * 86400_000);
    const topLevel = agentBinaryPath(TARGET, dir);
    mkdirSync(join(dir, 'agent', TARGET), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').symlinkSync(oldest, topLevel);

    const result = pruneAgentArtifacts({
      artifactsDir: dir,
      target: TARGET,
      keep: 1,
      execute: true,
    });
    // keep=1 → v0.3.0 stays (newest). v0.1.0 active, must survive.
    // So only v0.2.0 gets removed.
    expect(result.removed.map((r) => r.tag)).toEqual(['v0.2.0']);
    expect(existsSync(agentVersionDir(TARGET, 'v0.1.0', dir))).toBe(true);
    expect(existsSync(agentVersionDir(TARGET, 'v0.3.0', dir))).toBe(true);
  });

  test('target filter restricts prune to one platform', () => {
    seedVersion('v0.1.0', Date.now() - 4 * 86400_000);
    seedVersion('v0.2.0', Date.now() - 3 * 86400_000);
    // Seed a second platform too.
    const other = 'linux-x64';
    const ovdir = agentVersionDir(other, 'v0.1.0', dir);
    mkdirSync(ovdir, { recursive: true });
    writeFileSyncNode(join(ovdir, 'llamactl-agent'), new Uint8Array([1]));

    const result = pruneAgentArtifacts({
      artifactsDir: dir,
      target: TARGET,
      keep: 1,
      execute: true,
    });
    expect(result.removed.every((r) => r.target === TARGET)).toBe(true);
    expect(existsSync(join(ovdir, 'llamactl-agent'))).toBe(true);
  });

  test('keep=0 removes every non-active version', () => {
    const a = seedVersion('v0.1.0');
    seedVersion('v0.2.0');
    // Link v0.1.0 as active.
    const topLevel = agentBinaryPath(TARGET, dir);
    mkdirSync(join(dir, 'agent', TARGET), { recursive: true });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:fs').symlinkSync(a, topLevel);

    const result = pruneAgentArtifacts({
      artifactsDir: dir,
      target: TARGET,
      keep: 0,
      execute: true,
    });
    expect(result.removed.map((r) => r.tag)).toEqual(['v0.2.0']);
    expect(existsSync(agentVersionDir(TARGET, 'v0.1.0', dir))).toBe(true);
  });

  test('rejects negative keep', () => {
    expect(() =>
      pruneAgentArtifacts({ artifactsDir: dir, keep: -1 }),
    ).toThrow(/non-negative/);
  });
});
