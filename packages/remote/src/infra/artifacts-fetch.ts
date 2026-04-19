import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentBinaryPath, defaultArtifactsDir } from '../server/artifacts.js';

/**
 * Download an agent binary from a GitHub Release, verify its
 * SHA-256, and drop it at the path the central's /artifacts endpoint
 * expects.
 *
 * Injectable fetcher + clock — tests stub both so no CI run hits the
 * real github.com.
 */

export type ArtifactFetcher = (url: string, opts?: { accept?: string }) => Promise<{
  ok: boolean;
  status: number;
  body: Uint8Array;
  text: () => string;
}>;

async function defaultFetcher(url: string, opts?: { accept?: string }): Promise<{
  ok: boolean;
  status: number;
  body: Uint8Array;
  text: () => string;
}> {
  const headers: Record<string, string> = {};
  if (opts?.accept) headers.accept = opts.accept;
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  const arrayBuffer = await res.arrayBuffer();
  const body = new Uint8Array(arrayBuffer);
  return {
    ok: res.ok,
    status: res.status,
    body,
    text: () => new TextDecoder().decode(body),
  };
}

const ALLOWED_TARGETS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
]);

export interface FetchAgentReleaseOptions {
  /** `owner/repo`, e.g. `frozename/llamactl`. */
  repo: string;
  /** `latest` or a `vX.Y.Z` tag. */
  version: string;
  /** Platform slug matching the server's allow-list. */
  target: string;
  /** Override the artifacts dir (tests). */
  artifactsDir?: string;
  fetcher?: ArtifactFetcher;
}

export type FetchAgentReleaseResult =
  | {
      ok: true;
      version: string;
      target: string;
      path: string;
      sha256: string;
      bytes: number;
    }
  | {
      ok: false;
      reason: 'unknown-target' | 'resolve-failed' | 'asset-missing' | 'download-failed' | 'sha-mismatch';
      message: string;
      detail?: unknown;
    };

function sha256hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parse a sha256-suffix line — CI emits two shapes:
 *   a) `<hex>  llamactl-agent-<target>\n`   (standard `shasum` output)
 *   b) `<hex>\n`                             (bare hex)
 * We accept both so operators hand-rolling checksums aren't locked
 * out of the verification path.
 */
export function parseShaLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = /^([0-9a-f]{64})\b/i.exec(trimmed);
  return match ? match[1]!.toLowerCase() : null;
}

async function resolveLatestTag(
  repo: string,
  fetcher: ArtifactFetcher,
): Promise<{ ok: true; tag: string } | { ok: false; message: string }> {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const res = await fetcher(url, { accept: 'application/vnd.github+json' });
  if (!res.ok) {
    return {
      ok: false,
      message: `GitHub API ${res.status} for ${url}: ${res.text().slice(0, 300)}`,
    };
  }
  try {
    const parsed = JSON.parse(res.text()) as { tag_name?: unknown };
    if (typeof parsed.tag_name !== 'string' || parsed.tag_name.length === 0) {
      return { ok: false, message: 'GitHub latest release has no tag_name' };
    }
    return { ok: true, tag: parsed.tag_name };
  } catch (err) {
    return { ok: false, message: `malformed GitHub API response: ${(err as Error).message}` };
  }
}

/** Build the release-asset download URL for a given {tag, target}. */
export function agentAssetUrl(repo: string, tag: string, target: string): string {
  return `https://github.com/${repo}/releases/download/${tag}/llamactl-agent-${target}`;
}

export function agentAssetShaUrl(repo: string, tag: string, target: string): string {
  return `${agentAssetUrl(repo, tag, target)}.sha256`;
}

export async function fetchAgentRelease(
  opts: FetchAgentReleaseOptions,
): Promise<FetchAgentReleaseResult> {
  if (!ALLOWED_TARGETS.has(opts.target)) {
    return {
      ok: false,
      reason: 'unknown-target',
      message: `unknown --target ${opts.target} (allowed: ${[...ALLOWED_TARGETS].sort().join(', ')})`,
    };
  }
  const fetcher = opts.fetcher ?? defaultFetcher;

  let tag = opts.version;
  if (tag === 'latest') {
    const resolved = await resolveLatestTag(opts.repo, fetcher);
    if (!resolved.ok) {
      return { ok: false, reason: 'resolve-failed', message: resolved.message };
    }
    tag = resolved.tag;
  }

  const binUrl = agentAssetUrl(opts.repo, tag, opts.target);
  const shaUrl = agentAssetShaUrl(opts.repo, tag, opts.target);

  const [binRes, shaRes] = await Promise.all([
    fetcher(binUrl, { accept: 'application/octet-stream' }),
    fetcher(shaUrl, { accept: 'text/plain' }),
  ]);
  if (!binRes.ok) {
    return {
      ok: false,
      reason: 'asset-missing',
      message: `binary asset ${binUrl} returned ${binRes.status}`,
      detail: { url: binUrl, status: binRes.status },
    };
  }
  if (!shaRes.ok) {
    return {
      ok: false,
      reason: 'asset-missing',
      message: `sha256 asset ${shaUrl} returned ${shaRes.status}`,
      detail: { url: shaUrl, status: shaRes.status },
    };
  }
  const expectedSha = parseShaLine(shaRes.text());
  if (!expectedSha) {
    return {
      ok: false,
      reason: 'download-failed',
      message: `sha256 file content is not a valid hex hash`,
      detail: { body: shaRes.text().slice(0, 100) },
    };
  }
  const actualSha = sha256hex(binRes.body);
  if (actualSha !== expectedSha) {
    return {
      ok: false,
      reason: 'sha-mismatch',
      message: `sha256 mismatch: expected ${expectedSha}, got ${actualSha}`,
      detail: { expected: expectedSha, actual: actualSha, bytes: binRes.body.length },
    };
  }

  const artifactsDir = opts.artifactsDir ?? defaultArtifactsDir();
  const outPath = agentBinaryPath(opts.target, artifactsDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, binRes.body);
  try {
    chmodSync(outPath, 0o755);
  } catch {
    // best-effort on platforms where chmod is a no-op
  }
  // Also write the sha alongside so operators can re-verify later
  // with `shasum -a 256 -c`.
  writeFileSync(`${outPath}.sha256`, shaRes.text().endsWith('\n') ? shaRes.text() : `${shaRes.text()}\n`);

  return {
    ok: true,
    version: tag,
    target: opts.target,
    path: outPath,
    sha256: actualSha,
    bytes: binRes.body.length,
  };
}

// Re-export for the CLI module's Map-based Set membership check.
export function isKnownAgentTarget(target: string): boolean {
  return ALLOWED_TARGETS.has(target);
}

// Helper for building the `--dir` path display string on the CLI.
export { join as joinPath };
