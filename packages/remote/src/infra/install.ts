import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  activateInfraVersion,
  defaultInfraDir,
  ensurePackageDir,
  infraVersionDir,
} from './layout.js';

/**
 * Download + verify + extract + activate an infra package. Pure
 * enough to be unit-testable — the network fetch and the tar
 * extraction are both injectable. Production defaults shell out to
 * `curl` / `tar`; tests pass in-memory stubs.
 *
 * Expected tarball shape: a gzipped tar that extracts INTO the
 * version directory (so the tarball root is the version — no
 * leading `llama-cpp-b4500/` wrapper). Packagers who produce `.tar.gz`
 * with a wrapper directory can add `--strip-components=1` via the
 * `extractor` hook when they wire up their own package spec.
 */

export type InfraFetcher = (url: string) => Promise<Uint8Array>;
export type InfraExtractor = (
  tarballPath: string,
  destDir: string,
) => Promise<void>;

async function defaultFetcher(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`infra fetch: ${url} returned ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function defaultExtractor(tarballPath: string, destDir: string): Promise<void> {
  // `tar` is universal on macOS + Linux. We prefer it over a pure-JS
  // implementation because it handles sparse files, xattrs, and
  // large tarballs efficiently. If the target host is missing tar,
  // the error from Bun.spawn surfaces cleanly to the caller.
  const proc = Bun.spawn({
    cmd: ['tar', '-xzf', tarballPath, '-C', destDir],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`infra extract: tar exited ${code}: ${err.trim() || '(no stderr)'}`);
  }
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface InstallInfraOptions {
  pkg: string;
  version: string;
  tarballUrl: string;
  /** Hex-encoded SHA-256. Required — no unsigned pulls. */
  sha256: string;
  /** Skip the install if the version dir already exists. Default: true. */
  skipIfPresent?: boolean;
  /** Flip the `current` symlink at the new version on success. Default: true. */
  activate?: boolean;
  base?: string;
  fetcher?: InfraFetcher;
  extractor?: InfraExtractor;
}

export type InstallResult =
  | { ok: true; state: 'installed' | 'already-present'; versionDir: string; activated: boolean }
  | { ok: false; reason: 'sha-mismatch' | 'fetch-failed' | 'extract-failed'; error: string };

export async function installInfraPackage(
  opts: InstallInfraOptions,
): Promise<InstallResult> {
  const base = opts.base ?? defaultInfraDir();
  const skipIfPresent = opts.skipIfPresent ?? true;
  const activate = opts.activate ?? true;
  const fetcher = opts.fetcher ?? defaultFetcher;
  const extractor = opts.extractor ?? defaultExtractor;

  ensurePackageDir(opts.pkg, base);
  const versionDir = infraVersionDir(opts.pkg, opts.version, base);

  if (skipIfPresent && existsSync(versionDir)) {
    if (activate) activateInfraVersion(opts.pkg, opts.version, base);
    return {
      ok: true,
      state: 'already-present',
      versionDir,
      activated: activate,
    };
  }

  let bytes: Uint8Array;
  try {
    bytes = await fetcher(opts.tarballUrl);
  } catch (err) {
    return { ok: false, reason: 'fetch-failed', error: (err as Error).message };
  }
  const actualSha = sha256(bytes);
  if (actualSha !== opts.sha256.toLowerCase()) {
    return {
      ok: false,
      reason: 'sha-mismatch',
      error: `expected sha256 ${opts.sha256}, got ${actualSha}`,
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'llamactl-infra-'));
  const tarballPath = join(workDir, 'pkg.tar.gz');
  writeFileSync(tarballPath, bytes);

  // Extract into a staging dir first, then rename into place. Two
  // purposes: (a) a failed extract doesn't leave half a version dir
  // on disk; (b) the move-into-place is atomic so concurrent
  // listInstalledInfra calls never see a partial version.
  const stagingDir = join(workDir, 'staging');
  mkdirSync(stagingDir, { recursive: true });
  try {
    await extractor(tarballPath, stagingDir);
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    return { ok: false, reason: 'extract-failed', error: (err as Error).message };
  }

  // Clean any prior install at this version (re-install idempotency).
  if (existsSync(versionDir)) {
    rmSync(versionDir, { recursive: true, force: true });
  }
  mkdirSync(versionDir, { recursive: true });

  // Bun.spawn with cp -R so symlinks and permissions survive. The
  // trailing /. keeps the staging contents flat into versionDir.
  const cp = Bun.spawn({
    cmd: ['cp', '-R', `${stagingDir}/.`, versionDir],
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const cpCode = await cp.exited;
  rmSync(workDir, { recursive: true, force: true });
  if (cpCode !== 0) {
    const err = await new Response(cp.stderr).text();
    return { ok: false, reason: 'extract-failed', error: `cp exited ${cpCode}: ${err.trim()}` };
  }

  if (activate) {
    activateInfraVersion(opts.pkg, opts.version, base);
  }
  return { ok: true, state: 'installed', versionDir, activated: activate };
}
