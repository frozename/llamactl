import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Versioned side-by-side layout for infra packages on an agent host.
 *
 *   <base>/
 *     <pkg>/
 *       <version>/            (one versioned install per row)
 *         bin/...
 *         ...
 *       current -> <version>  (symlink; which version is "live")
 *
 * `current` is a relative symlink so the whole infra tree stays
 * movable / rsync-able. Flips are atomic via rename-over (write new
 * symlink at a temp path, rename onto the final path).
 *
 * Design lock confirmed 2026-04-18: side-by-side versions + a
 * `current` symlink (rather than one-at-a-time). Rollback is free,
 * concurrent installs are straightforward, downside is ~50 MB of
 * extra disk per extra version of llama-cpp.
 */

export function defaultInfraDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_INFRA_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'infra');
}

export function infraPackageDir(pkg: string, base: string = defaultInfraDir()): string {
  return join(base, pkg);
}

export function infraVersionDir(
  pkg: string,
  version: string,
  base: string = defaultInfraDir(),
): string {
  return join(base, pkg, version);
}

export function infraCurrentSymlink(
  pkg: string,
  base: string = defaultInfraDir(),
): string {
  return join(base, pkg, 'current');
}

export interface InstalledInfra {
  pkg: string;
  versions: string[];
  active: string | null;
}

/**
 * Enumerate every installed package + its versions + which version
 * is currently active (the `current` symlink target). Missing infra
 * dir yields an empty array; malformed symlinks yield `active: null`
 * without throwing.
 */
export function listInstalledInfra(base: string = defaultInfraDir()): InstalledInfra[] {
  if (!existsSync(base)) return [];
  const rows: InstalledInfra[] = [];
  for (const pkg of readdirSync(base)) {
    const pkgDir = join(base, pkg);
    let stat;
    try {
      stat = lstatSync(pkgDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const versions: string[] = [];
    for (const entry of readdirSync(pkgDir)) {
      if (entry === 'current') continue;
      const entryPath = join(pkgDir, entry);
      try {
        if (lstatSync(entryPath).isDirectory()) versions.push(entry);
      } catch {
        // skip
      }
    }
    versions.sort();
    let active: string | null = null;
    const currentPath = infraCurrentSymlink(pkg, base);
    if (existsSync(currentPath)) {
      try {
        const target = readlinkSync(currentPath);
        // The symlink stores a relative version name (or absolute
        // path); accept either shape.
        active = basename(target);
        if (!versions.includes(active)) {
          // Target points at something we don't recognize as an
          // installed version; surface as "unknown" rather than
          // fabricating an active row.
          active = null;
        }
      } catch {
        active = null;
      }
    }
    rows.push({ pkg, versions, active });
  }
  rows.sort((a, b) => a.pkg.localeCompare(b.pkg));
  return rows;
}

/**
 * Atomically point `<base>/<pkg>/current` at a specific version.
 * Uses a symlink-at-tmp-path + rename dance so concurrent readers
 * never see a half-written or missing link.
 */
export function activateInfraVersion(
  pkg: string,
  version: string,
  base: string = defaultInfraDir(),
): void {
  const pkgDir = infraPackageDir(pkg, base);
  const versionDir = infraVersionDir(pkg, version, base);
  if (!existsSync(versionDir)) {
    throw new Error(`activateInfraVersion: ${pkg}@${version} not installed at ${versionDir}`);
  }
  mkdirSync(pkgDir, { recursive: true });
  const finalLink = infraCurrentSymlink(pkg, base);
  const tmpLink = `${finalLink}.tmp.${process.pid}.${Date.now()}`;
  try {
    // Clean any stale tmp link from a prior crashed flip.
    if (existsSync(tmpLink)) rmSync(tmpLink, { force: true });
    symlinkSync(version, tmpLink);
    renameSync(tmpLink, finalLink);
  } finally {
    try {
      if (existsSync(tmpLink)) rmSync(tmpLink, { force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Remove a single version directory. Safe to call on the version
 * that `current` points at — the symlink is NOT removed; caller's
 * responsibility to re-point or rm it. Returns true when something
 * was removed, false when the version wasn't installed.
 */
export function removeInfraVersion(
  pkg: string,
  version: string,
  base: string = defaultInfraDir(),
): boolean {
  const dir = infraVersionDir(pkg, version, base);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Remove the whole package — every version + the current symlink +
 * the pkg directory. Returns true when the package directory existed.
 */
export function removeInfraPackage(
  pkg: string,
  base: string = defaultInfraDir(),
): boolean {
  const dir = infraPackageDir(pkg, base);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Resolve the path that the `current` symlink points to for a
 * package. Returns null when the package isn't installed or the
 * symlink is missing.
 */
export function resolveCurrentVersion(
  pkg: string,
  base: string = defaultInfraDir(),
): { version: string; dir: string } | null {
  const link = infraCurrentSymlink(pkg, base);
  if (!existsSync(link)) return null;
  try {
    const target = readlinkSync(link);
    const version = basename(target);
    const dir = infraVersionDir(pkg, version, base);
    if (!existsSync(dir)) return null;
    return { version, dir };
  } catch {
    return null;
  }
}

/**
 * Ensure `<base>/<pkg>/` exists, since tarball extraction targets
 * this path before the version dir itself is populated.
 */
export function ensurePackageDir(
  pkg: string,
  base: string = defaultInfraDir(),
): string {
  const dir = infraPackageDir(pkg, base);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Re-export lightly so install.ts + future consumers have a clean
// default-dir-aware surface.
export { dirname };
