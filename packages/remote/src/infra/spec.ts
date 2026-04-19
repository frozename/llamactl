import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * Package spec format for infra deployments. One YAML file per
 * package under `~/.llamactl/packages/<pkg>.yaml`:
 *
 *   name: llama-cpp
 *   versions:
 *     b4500:
 *       platforms:
 *         darwin-arm64:
 *           url: https://.../llama-b4500-bin-macos-arm64.tar.gz
 *           sha256: abcd...
 *         darwin-x64:  { url: ..., sha256: ... }
 *         linux-x64:   { url: ..., sha256: ... }
 *         linux-arm64: { url: ..., sha256: ... }
 *       # Optional per-version metadata.
 *       service: false       # llama-cpp is a binary, not a service.
 *       notes: "llama.cpp build b4500"
 *   default: b4500            # optional — CLI picks this when
 *                              --version is omitted (future).
 *
 * `llamactl infra install <pkg> --version=<v> --node=<n>` reads the
 * spec, asks the target node what platform it runs, and derives the
 * (url, sha256) that gets pushed through the existing
 * `installInfraPackage` function. Operators can still override with
 * explicit --tarball-url + --sha256 for ad-hoc packages.
 */

export const InfraPlatformKindSchema = z.enum([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
]);
export type InfraPlatformKind = z.infer<typeof InfraPlatformKindSchema>;

export const InfraArtifactSchema = z.object({
  url: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
});
export type InfraArtifact = z.infer<typeof InfraArtifactSchema>;

// Explicit partial record — zod 4's `z.record(enum, X)` produces
// Record<K, X> where every enum key is required, which is the wrong
// semantics here (llama-cpp publishes all four targets; embersynth
// might ship only one or two). z.object + .partial keeps the key
// set closed while each platform is optional.
const PlatformsSchema = z.object({
  'darwin-arm64': InfraArtifactSchema,
  'darwin-x64': InfraArtifactSchema,
  'linux-x64': InfraArtifactSchema,
  'linux-arm64': InfraArtifactSchema,
}).partial();

export const InfraVersionSpecSchema = z.object({
  platforms: PlatformsSchema,
  /** Whether this version runs as a supervised service (embersynth,
   *  sirius) or as a bare binary (llama-cpp). Default false. */
  service: z.boolean().default(false),
  notes: z.string().optional(),
});
export type InfraVersionSpec = z.infer<typeof InfraVersionSpecSchema>;

export const InfraPackageSpecSchema = z.object({
  name: z.string().min(1),
  versions: z.record(z.string().min(1), InfraVersionSpecSchema),
  /** Default version when `--version` is omitted on the CLI. */
  default: z.string().min(1).optional(),
});
export type InfraPackageSpec = z.infer<typeof InfraPackageSpecSchema>;

export function defaultInfraPackagesDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_INFRA_PACKAGES_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'packages');
}

export function infraPackageSpecPath(
  pkg: string,
  dir: string = defaultInfraPackagesDir(),
): string {
  return join(dir, `${pkg}.yaml`);
}

export function loadInfraPackageSpec(
  pkg: string,
  dir: string = defaultInfraPackagesDir(),
): InfraPackageSpec {
  const path = infraPackageSpecPath(pkg, dir);
  if (!existsSync(path)) {
    throw new Error(
      `infra package spec not found at ${path} — write one, or pass --tarball-url + --sha256 directly`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  return InfraPackageSpecSchema.parse(parseYaml(raw));
}

export interface ListedInfraPackageSpec {
  name: string;
  path: string;
  versions: string[];
  default: string | null;
}

export function listInfraPackageSpecs(
  dir: string = defaultInfraPackagesDir(),
): ListedInfraPackageSpec[] {
  if (!existsSync(dir)) return [];
  const out: ListedInfraPackageSpec[] = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.yaml')) continue;
    const path = join(dir, entry);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = InfraPackageSpecSchema.parse(parseYaml(raw));
      out.push({
        name: parsed.name,
        path,
        versions: Object.keys(parsed.versions).sort(),
        default: parsed.default ?? null,
      });
    } catch {
      // Skip malformed specs — surface via a dedicated validate
      // command when we add one.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export type ResolveArtifactResult =
  | { ok: true; artifact: InfraArtifact; platform: InfraPlatformKind }
  | { ok: false; reason: 'unknown-version' | 'unknown-platform'; message: string };

/**
 * Derive the (url, sha256) for a specific (pkg, version, platform)
 * triple from a loaded spec. Never throws — returns a structured
 * result so callers can surface the right CLI error message.
 */
export function resolveInfraArtifact(
  spec: InfraPackageSpec,
  version: string,
  platform: InfraPlatformKind,
): ResolveArtifactResult {
  const versionSpec = spec.versions[version];
  if (!versionSpec) {
    const known = Object.keys(spec.versions).sort();
    return {
      ok: false,
      reason: 'unknown-version',
      message: `${spec.name}: unknown version ${version} (available: ${known.join(', ') || '(none)'})`,
    };
  }
  const artifact = versionSpec.platforms[platform];
  if (!artifact) {
    const known = Object.keys(versionSpec.platforms).sort();
    return {
      ok: false,
      reason: 'unknown-platform',
      message: `${spec.name}@${version}: no artifact for ${platform} (available: ${known.join(', ') || '(none)'})`,
    };
  }
  return { ok: true, artifact, platform };
}
