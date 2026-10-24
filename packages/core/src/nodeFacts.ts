import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

import type { MachineProfile } from "./types.js";

import { resolveBuildId } from "./build.js";
import { resolveEnv } from "./env.js";
import { detectMemoryBytes, resolveProfile } from "./profile.js";
import { advertisedEndpoint } from "./server.js";

export type GpuKind = "metal" | "cuda" | "rocm" | "vulkan" | "cpu";

export interface GpuInfo {
  kind: GpuKind;
  name?: string;
  memoryMB?: number;
}

export interface Versions {
  llamactl: string;
  bun: string;
  llamaCppSrcRev: string | null;
}

export interface NodeFacts {
  nodeName: string;
  profile: MachineProfile;
  memBytes: number | null;
  os: NodeJS.Platform;
  arch: string;
  platform: string; // "darwin-arm64", "linux-x64", ...
  llamaCppBuildId: string | null;
  gpu: GpuInfo | null;
  versions: Versions;
  startedAt: string; // ISO-8601
  /**
   * URL this node advertises for its llama-server, derived from
   * LLAMA_CPP_ADVERTISED_HOST / LLAMA_CPP_HOST / LLAMA_CPP_PORT.
   * Orchestrators use this to reach the node's OpenAI-compatible
   * endpoint without needing to know how the node is bound.
   */
  advertisedEndpoint: string;
}

// Capture once at module load — the agent's process lifetime matches the
// node's "uptime" from the control plane's perspective, so this is the
// right staleness marker for the reported facts.
const STARTED_AT = new Date().toISOString();

// Hard-coded for now; package.json reads involve tsconfig/import-attrs
// gymnastics that aren't worth it for a version string. Bump here when
// cutting a release.
const LLAMACTL_VERSION = "0.0.0";

export function resolveNodeName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["LLAMACTL_NODE_NAME"]?.trim();
  if (override) return override;
  const host = hostname().trim();
  return host || "local";
}

export function collectNodeFacts(env: NodeJS.ProcessEnv = process.env): NodeFacts {
  const resolved = safeResolveEnv(env);
  return {
    nodeName: resolveNodeName(env),
    profile: resolveProfile(env),
    memBytes: detectMemoryBytes(),
    os: process.platform,
    arch: process.arch,
    platform: `${process.platform}-${process.arch}`,
    llamaCppBuildId: resolved ? safeResolveBuildId(resolved) : null,
    gpu: detectGpu(),
    versions: resolveVersions(env),
    startedAt: STARTED_AT,
    advertisedEndpoint: resolved ? advertisedEndpoint(resolved) : "",
  };
}

export function resolveVersions(_env: NodeJS.ProcessEnv = process.env): Versions {
  return {
    llamactl: LLAMACTL_VERSION,
    bun: resolveBunVersion(),
    llamaCppSrcRev: detectLlamaCppRev(_env),
  };
}

// ----- GPU detection -----------------------------------------------------

export type GpuProbeExec = (file: string, args: string[]) => string;

export interface GpuProbeDeps {
  platform?: NodeJS.Platform;
  exec?: GpuProbeExec;
}

const defaultGpuExec: GpuProbeExec = (file, args) =>
  execFileSync(file, args, {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    timeout: 2000,
  });

export function detectGpu(deps: GpuProbeDeps = {}): GpuInfo | null {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultGpuExec;
  if (platform === "darwin") return detectMetal(exec);
  if (platform === "linux") {
    return detectNvidia(exec) ?? detectRocm(exec) ?? detectVulkan(exec) ?? { kind: "cpu" };
  }
  return { kind: "cpu" };
}

function detectMetal(exec: GpuProbeExec): GpuInfo | null {
  try {
    const raw = exec("system_profiler", ["SPDisplaysDataType", "-json"]).trim();
    const parsed = JSON.parse(raw) as {
      SPDisplaysDataType?: Record<string, unknown>[];
    };
    const first = parsed.SPDisplaysDataType?.[0];
    if (!first) return { kind: "metal" };
    const name = typeof first["_name"] === "string" ? first["_name"] : undefined;
    const vramRaw =
      typeof first["spdisplays_vram"] === "string"
        ? first["spdisplays_vram"]
        : typeof first["spdisplays_vram_shared"] === "string"
          ? first["spdisplays_vram_shared"]
          : undefined;
    const memoryMB = vramRaw ? parseHumanToMB(vramRaw) : undefined;
    const info: GpuInfo = { kind: "metal" };
    if (name) info.name = name;
    if (memoryMB !== undefined) info.memoryMB = memoryMB;
    return info;
  } catch {
    return { kind: "metal" };
  }
}

function detectNvidia(exec: GpuProbeExec): GpuInfo | null {
  try {
    const out = exec("nvidia-smi", [
      "--query-gpu=name,memory.total",
      "--format=csv,noheader,nounits",
    ]).trim();
    if (!out) return null;
    const firstLine = out.split("\n")[0];
    if (!firstLine) return null;
    const [rawName, rawMem] = firstLine.split(",").map((s) => s.trim());
    const info: GpuInfo = { kind: "cuda" };
    if (rawName) info.name = rawName;
    const memMB = rawMem ? Number.parseInt(rawMem, 10) : NaN;
    if (Number.isFinite(memMB) && memMB > 0) info.memoryMB = memMB;
    return info;
  } catch {
    return null;
  }
}

function detectRocm(exec: GpuProbeExec): GpuInfo | null {
  try {
    const out = exec("rocminfo", []);
    // rocminfo exits 0 on CPU-only APUs too; only a listed GPU agent
    // proves the ROCm stack actually drives a GPU.
    if (!/^\s*Device Type:\s*GPU\s*$/m.test(out)) return null;
    return { kind: "rocm" };
  } catch {
    return null;
  }
}

function detectVulkan(exec: GpuProbeExec): GpuInfo | null {
  try {
    const out = exec("vulkaninfo", ["--summary"]);
    const blocks: { type: string; name: string }[] = [];
    let current: { type: string; name: string } | null = null;
    for (const line of out.split("\n")) {
      if (/^GPU\d+:/.test(line)) {
        current = { type: "", name: "" };
        blocks.push(current);
        continue;
      }
      if (!current) continue;
      const type = /^\s*deviceType\s*=\s*(\S+)/.exec(line)?.[1];
      if (type) current.type = type;
      const name = /^\s*deviceName\s*=\s*(\S.*)$/.exec(line)?.[1]?.trim();
      if (name) current.name = name;
    }
    const pick =
      blocks.find((b) => b.type === "PHYSICAL_DEVICE_TYPE_DISCRETE_GPU") ??
      blocks.find((b) => b.type === "PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU");
    if (!pick) return null;
    const info: GpuInfo = { kind: "vulkan" };
    if (pick.name) info.name = pick.name;
    return info;
  } catch {
    return null;
  }
}

function parseHumanToMB(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i.exec(s.trim());
  if (!m?.[1] || !m[2]) return undefined;
  const num = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor =
    unit === "KB" ? 1 / 1024 : unit === "MB" ? 1 : unit === "GB" ? 1024 : /* TB */ 1024 * 1024;
  return Math.round(num * factor);
}

// ----- Version helpers ---------------------------------------------------

function resolveBunVersion(): string {
  // process.versions.bun exists under Bun; under plain Node it's absent.
  const v = (process.versions as Record<string, string | undefined>)["bun"];
  return v ?? "unknown";
}

function detectLlamaCppRev(env: NodeJS.ProcessEnv): string | null {
  const resolved = safeResolveEnv(env);
  if (!resolved) return null;
  try {
    const out = execFileSync("git", ["-C", resolved.LLAMA_CPP_SRC, "rev-parse", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

function safeResolveEnv(env: NodeJS.ProcessEnv): ReturnType<typeof resolveEnv> | null {
  try {
    return resolveEnv(env);
  } catch {
    return null;
  }
}

function safeResolveBuildId(resolved: ReturnType<typeof resolveEnv>): string | null {
  try {
    const id = resolveBuildId(resolved);
    return id === "unknown" ? null : id;
  } catch {
    return null;
  }
}
