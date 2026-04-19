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
  /**
   * Cosign keyless signature verification (I.5.3).
   *
   *   - `'skip'` (default): do not touch signatures. Assets downloaded
   *     pass sha256 only.
   *   - `'best-effort'`: download the `.sig` + `.cert` files when
   *     present; if cosign is on PATH, verify; if anything is missing
   *     (signature not uploaded, cosign not installed), continue
   *     silently. Returns `signature: { verified: null, reason }` so
   *     callers can surface the why.
   *   - `'require'`: fail the fetch when verification can't be
   *     completed — missing asset, missing cosign, or verification
   *     mismatch. Returns `reason: 'sig-verify-failed'`.
   */
  verifySig?: 'skip' | 'best-effort' | 'require';
  /** Override the cosign invocation — tests stub this. Receives the
   *  three paths (binary, sig, cert) + repo + tag and returns
   *  verification result. */
  cosignVerifier?: CosignVerifier;
}

export interface CosignVerifyInput {
  binaryPath: string;
  sigPath: string;
  certPath: string;
  repo: string;
  tag: string;
}

export type CosignVerifier = (
  input: CosignVerifyInput,
) => Promise<{ ok: true } | { ok: false; message: string }>;

export interface SignatureOutcome {
  /** true = cosign verified; false = cosign reported mismatch;
   *  null = verification skipped (missing assets, missing cosign,
   *  or --verify-sig=skip). */
  verified: boolean | null;
  /** Human-readable explanation — "not attempted", "cosign not on
   *  PATH", "verified", "mismatch: …". */
  reason: string;
}

export type FetchAgentReleaseResult =
  | {
      ok: true;
      version: string;
      target: string;
      path: string;
      sha256: string;
      bytes: number;
      signature: SignatureOutcome;
    }
  | {
      ok: false;
      reason:
        | 'unknown-target'
        | 'resolve-failed'
        | 'asset-missing'
        | 'download-failed'
        | 'sha-mismatch'
        | 'sig-verify-failed';
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

export function agentAssetSigUrl(repo: string, tag: string, target: string): string {
  return `${agentAssetUrl(repo, tag, target)}.sig`;
}

export function agentAssetCertUrl(repo: string, tag: string, target: string): string {
  return `${agentAssetUrl(repo, tag, target)}.cert`;
}

/**
 * Build the `--certificate-identity-regexp` value cosign expects for
 * release-agent.yml workflow runs. Keyed on `<owner>/<repo>` +
 * a trailing `vX.Y.Z` tag match.
 */
export function cosignIdentityRegex(repo: string): string {
  const escaped = repo.replace(/[.\\+*?^$()[\]{}|]/g, '\\$&');
  return `^https://github\\.com/${escaped}/\\.github/workflows/release-agent\\.yml@refs/tags/v.+$`;
}

const COSIGN_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

/**
 * Default cosign verifier: spawns `cosign verify-blob` as a subprocess
 * with the keyless identity regex + OIDC issuer. Resolves with
 * `{ok: true}` on exit 0, `{ok: false, message}` otherwise. Captures
 * stderr so the operator sees the real failure reason.
 */
async function defaultCosignVerifier(
  input: CosignVerifyInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const proc = Bun.spawn({
      cmd: [
        'cosign',
        'verify-blob',
        '--certificate-identity-regexp',
        cosignIdentityRegex(input.repo),
        '--certificate-oidc-issuer',
        COSIGN_OIDC_ISSUER,
        '--signature',
        input.sigPath,
        '--certificate',
        input.certPath,
        input.binaryPath,
      ],
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    if (code === 0) return { ok: true };
    const stderr = await new Response(proc.stderr).text();
    return {
      ok: false,
      message: stderr.trim().slice(0, 500) || `cosign exited ${code}`,
    };
  } catch (err) {
    return { ok: false, message: `cosign invocation failed: ${(err as Error).message}` };
  }
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

  const verifyMode = opts.verifySig ?? 'skip';
  const signature = await maybeVerifySignature({
    mode: verifyMode,
    repo: opts.repo,
    tag,
    target: opts.target,
    binaryPath: outPath,
    fetcher,
    cosignVerifier: opts.cosignVerifier ?? defaultCosignVerifier,
  });

  if (verifyMode === 'require' && signature.verified !== true) {
    return {
      ok: false,
      reason: 'sig-verify-failed',
      message: `signature verification failed: ${signature.reason}`,
      detail: signature,
    };
  }

  return {
    ok: true,
    version: tag,
    target: opts.target,
    path: outPath,
    sha256: actualSha,
    bytes: binRes.body.length,
    signature,
  };
}

interface MaybeVerifyOptions {
  mode: 'skip' | 'best-effort' | 'require';
  repo: string;
  tag: string;
  target: string;
  binaryPath: string;
  fetcher: ArtifactFetcher;
  cosignVerifier: CosignVerifier;
}

async function maybeVerifySignature(opts: MaybeVerifyOptions): Promise<SignatureOutcome> {
  if (opts.mode === 'skip') {
    return { verified: null, reason: 'verification skipped (--verify-sig not set)' };
  }
  const sigUrl = agentAssetSigUrl(opts.repo, opts.tag, opts.target);
  const certUrl = agentAssetCertUrl(opts.repo, opts.tag, opts.target);
  const [sigRes, certRes] = await Promise.all([
    opts.fetcher(sigUrl, { accept: 'application/octet-stream' }),
    opts.fetcher(certUrl, { accept: 'application/octet-stream' }),
  ]);
  if (!sigRes.ok || !certRes.ok) {
    return {
      verified: null,
      reason: `signature assets missing (.sig=${sigRes.status} .cert=${certRes.status})`,
    };
  }
  const sigPath = `${opts.binaryPath}.sig`;
  const certPath = `${opts.binaryPath}.cert`;
  writeFileSync(sigPath, sigRes.body);
  writeFileSync(certPath, certRes.body);
  const result = await opts.cosignVerifier({
    binaryPath: opts.binaryPath,
    sigPath,
    certPath,
    repo: opts.repo,
    tag: opts.tag,
  });
  if (result.ok) {
    return { verified: true, reason: 'cosign verify-blob succeeded' };
  }
  return { verified: false, reason: result.message };
}

// Re-export for the CLI module's Map-based Set membership check.
export function isKnownAgentTarget(target: string): boolean {
  return ALLOWED_TARGETS.has(target);
}

// Helper for building the `--dir` path display string on the CLI.
export { join as joinPath };
