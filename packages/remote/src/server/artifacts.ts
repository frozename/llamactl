import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Artifact server for the Sprint I-α bootstrap flow. Serves
 * pre-built llamactl-agent binaries that the install-agent.sh
 * script downloads.
 *
 * Layout on the central host:
 *   ~/.llamactl/artifacts/agent/<platform>/llamactl-agent
 *
 * Platforms recognized:
 *   darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
 *
 * Operator fills the directory via `bun build --compile --target=...
 * packages/cli/src/bin.ts --outfile=<path>`. A CLI convenience
 * command (`llamactl artifacts build-agent`) lands in a follow-up.
 */

const ALLOWED_PLATFORMS = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
]);

export function defaultArtifactsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_ARTIFACTS_DIR?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'artifacts');
}

export function agentBinaryPath(platform: string, artifactsDir = defaultArtifactsDir()): string {
  return join(artifactsDir, 'agent', platform, 'llamactl-agent');
}

export interface ArtifactsHandlerOptions {
  artifactsDir?: string;
}

export function handleArtifact(
  req: Request,
  url: URL,
  opts: ArtifactsHandlerOptions = {},
): Response {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 });
  }
  // URL shape: /artifacts/agent/<platform>. Anything else 404s so we
  // don't accidentally reveal directory listings.
  const parts = url.pathname.split('/').filter((s) => s.length > 0);
  // parts: ['artifacts', 'agent', '<platform>']
  if (parts.length !== 3 || parts[0] !== 'artifacts' || parts[1] !== 'agent') {
    return new Response('not found', { status: 404 });
  }
  const platform = parts[2]!;
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return new Response(`unsupported platform: ${platform}`, { status: 404 });
  }
  const path = agentBinaryPath(platform, opts.artifactsDir);
  if (!existsSync(path)) {
    return new Response(
      `agent binary not built for ${platform} — run \`bun build --compile --target=bun-${platform} packages/cli/src/bin.ts --outfile=${path}\` on the control plane.`,
      { status: 404 },
    );
  }
  const stat = statSync(path);
  if (req.method === 'HEAD') {
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(stat.size),
      },
    });
  }
  // Bun streams Bun.file() natively — no manual chunking. The
  // binary is ~50 MB but the transport is a straight read; no
  // buffering into memory.
  const file = Bun.file(path);
  return new Response(file, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(stat.size),
      'content-disposition': `attachment; filename="llamactl-agent-${platform}"`,
      'cache-control': 'public, max-age=300',
    },
  });
}

export function listArtifacts(artifactsDir = defaultArtifactsDir()): Array<{
  platform: string;
  path: string;
  sizeBytes: number;
}> {
  const out: Array<{ platform: string; path: string; sizeBytes: number }> = [];
  for (const platform of ALLOWED_PLATFORMS) {
    const path = agentBinaryPath(platform, artifactsDir);
    if (!existsSync(path)) continue;
    out.push({ platform, path, sizeBytes: statSync(path).size });
  }
  return out;
}
