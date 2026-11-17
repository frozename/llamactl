import { llamactlHome } from "@llamactl/core/config/env";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { existsSync, readFileSync, statSync } from "../safe-fs.js";

/**
 * Artifact server for the Sprint I-α bootstrap flow. Serves
 * pre-built llamactl-agent binaries that the install-agent.sh
 * script downloads.
 *
 * Layout on the central host (#744):
 *   <artifacts>/agent/<platform>/current                     name of the served build
 *   <artifacts>/agent/<platform>/<commit12>[-dirty]/          per-commit builds
 *     llamactl-agent + manifest.json
 *   <artifacts>/agent/<platform>/versions/<tag>/llamactl-agent  fetched releases
 *   <artifacts>/agent/<platform>/llamactl-agent               served entrypoint: a
 *     symlink to the current build when `current` exists, otherwise the legacy
 *     plain file (kept byte-for-byte compatible with pre-#744 hosts).
 *
 * Platforms recognized:
 *   darwin-arm64 | darwin-x64 | linux-x64 | linux-arm64
 *
 * `llamactl artifacts build-agent` lands per-commit builds and flips
 * the `current` pointer; operators can still drop a plain file at the
 * legacy path and it keeps being served.
 */

/** Build dir name: 12 hex chars of commit, optional `-dirty` suffix. */
export const AGENT_BUILD_NAME_RE = /^[0-9a-f]{12}(-dirty)?$/;

/** On-disk directory name for one compiled build. */
export function agentBuildName(commit: string, dirty: boolean): string {
  return dirty ? `${commit.slice(0, 12)}-dirty` : commit.slice(0, 12);
}

/** Directory holding one compiled build's binary + manifest. */
export function agentBuildDir(platform: string, name: string, dir: string): string {
  return join(dir, "agent", platform, name);
}

/** Binary path inside one compiled build's directory. */
export function agentBuildBinaryPath(platform: string, name: string, dir: string): string {
  return join(agentBuildDir(platform, name, dir), "llamactl-agent");
}

/** Path of the `current` pointer file selecting the served build. */
export function agentCurrentPointerPath(platform: string, dir: string): string {
  return join(dir, "agent", platform, "current");
}

/** What a build's manifest.json records about the compile (#744). */
export interface AgentBuildManifest {
  platform: string;
  commit: string;
  dirty: boolean;
  sha256: string;
  builtAt: string;
  bun: string;
  signIdentity: string | null;
}

function parseAgentBuildManifest(parsed: unknown): AgentBuildManifest | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const platform = record["platform"];
  const commit = record["commit"];
  const dirty = record["dirty"];
  const sha256 = record["sha256"];
  const builtAt = record["builtAt"];
  const bun = record["bun"];
  const signIdentity = record["signIdentity"];
  if (
    typeof platform !== "string" ||
    typeof commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(commit) ||
    typeof dirty !== "boolean" ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256) ||
    typeof builtAt !== "string" ||
    typeof bun !== "string" ||
    !(signIdentity === null || typeof signIdentity === "string")
  ) {
    return null;
  }
  return { platform, commit, dirty, sha256, builtAt, bun, signIdentity };
}

/** Read + validate a build's manifest.json; null when missing/invalid. */
export function readAgentBuildManifest(
  platform: string,
  name: string,
  dir: string,
): AgentBuildManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(agentBuildDir(platform, name, dir), "manifest.json"), "utf8"),
    ) as unknown;
  } catch {
    return null;
  }
  return parseAgentBuildManifest(parsed);
}

export type ReadCurrentAgentBuildResult =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * Read the `current` pointer file. Null means no pointer (legacy
 * layout); `{ok: false, reason}` when its trimmed content fails
 * AGENT_BUILD_NAME_RE.
 */
export function readCurrentAgentBuild(
  platform: string,
  dir: string,
): ReadCurrentAgentBuildResult | null {
  const pointer = agentCurrentPointerPath(platform, dir);
  if (!existsSync(pointer)) return null;
  let raw: string;
  try {
    raw = readFileSync(pointer, "utf8");
  } catch (err) {
    return { ok: false, reason: `pointer could not be read: ${(err as Error).message}` };
  }
  const name = raw.trim();
  if (!AGENT_BUILD_NAME_RE.test(name)) {
    return { ok: false, reason: name };
  }
  return { ok: true, name };
}

const ALLOWED_PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"]);

export function defaultArtifactsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_ARTIFACTS_DIR"]?.trim();
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "artifacts");
}

export function agentBinaryPath(platform: string, artifactsDir = defaultArtifactsDir()): string {
  return join(artifactsDir, "agent", platform, "llamactl-agent");
}

export interface ArtifactsHandlerOptions {
  artifactsDir?: string;
}

export function handleArtifact(
  req: Request,
  url: URL,
  opts: ArtifactsHandlerOptions = {},
): Response {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("method not allowed", { status: 405 });
  }
  // URL shape: /artifacts/agent/<platform>. Anything else 404s so we
  // don't accidentally reveal directory listings.
  const parts = url.pathname.split("/").filter((s) => s.length > 0);
  // parts: ['artifacts', 'agent', '<platform>']
  if (parts.length !== 3 || parts[0] !== "artifacts" || parts[1] !== "agent") {
    return new Response("not found", { status: 404 });
  }
  const platform = parts[2] ?? "";
  if (!ALLOWED_PLATFORMS.has(platform)) {
    return new Response(`unsupported platform: ${platform}`, { status: 404 });
  }
  const dir = opts.artifactsDir ?? defaultArtifactsDir();
  const current = readCurrentAgentBuild(platform, dir);
  if (current !== null) {
    return serveCurrentBuild(req, platform, dir, current);
  }
  // No current pointer — legacy layout, served straight from the
  // top-level path.
  const path = agentBinaryPath(platform, dir);
  if (!existsSync(path)) {
    return new Response(
      `agent binary not built for ${platform} — run \`bun build --compile --target=bun-${platform} packages/cli/src/bin.ts --outfile=${path}\` on the control plane.`,
      { status: 404 },
    );
  }
  const stat = statSync(path);
  if (req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(stat.size),
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
      "content-type": "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `attachment; filename="llamactl-agent-${platform}"`,
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * Serve the build named by the `current` pointer. Failures are 500 —
 * a broken pointer must never silently fall back to a stale legacy
 * binary (#744). GET/HEAD carry `x-sha256` + `x-llamactl-commit` from
 * the manifest so installers can verify without a second request.
 *
 * The handler reads the binary once, hashes exactly those bytes and
 * serves them only when they match the manifest's sha256. A same-name
 * rebuild renames the binary and then the manifest; a request landing
 * between the two renames gets a 503 + Retry-After rather than new
 * bytes paired with the old `x-sha256`. The binary is buffered (not
 * streamed) for that reason — installs are rare and the agent is tens
 * of MB, and a stream opened after the hash could see another inode.
 */
function serveCurrentBuild(
  req: Request,
  platform: string,
  dir: string,
  current: ReadCurrentAgentBuildResult,
): Response {
  if (!current.ok) {
    const pointer = agentCurrentPointerPath(platform, dir);
    return new Response(`invalid current pointer at ${pointer}`, { status: 500 });
  }
  const name = current.name;
  const binary = agentBuildBinaryPath(platform, name, dir);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(binary);
  } catch {
    return new Response(`current pointer names ${name} but ${binary} is missing`, { status: 500 });
  }
  const manifest = readAgentBuildManifest(platform, name, dir);
  if (!manifest) {
    return new Response(`manifest for ${name} is missing or invalid`, { status: 500 });
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== manifest.sha256) {
    return new Response(
      `build ${name} is being republished (binary sha256 ${sha256} does not match manifest ${manifest.sha256}) — retry shortly`,
      { status: 503, headers: { "retry-after": "1" } },
    );
  }
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-length": String(bytes.byteLength),
    "x-sha256": sha256,
    "x-llamactl-commit": manifest.commit,
  };
  if (req.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      ...headers,
      "content-disposition": `attachment; filename="llamactl-agent-${platform}"`,
      "cache-control": "public, max-age=300",
    },
  });
}

export function listArtifacts(artifactsDir = defaultArtifactsDir()): {
  platform: string;
  path: string;
  sizeBytes: number;
}[] {
  const out: { platform: string; path: string; sizeBytes: number }[] = [];
  for (const platform of ALLOWED_PLATFORMS) {
    const path = agentBinaryPath(platform, artifactsDir);
    if (!existsSync(path)) continue;
    out.push({ platform, path, sizeBytes: statSync(path).size });
  }
  return out;
}
