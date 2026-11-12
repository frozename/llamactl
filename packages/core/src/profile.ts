import { execSync } from "node:child_process";
import { platform } from "node:os";

import type { MachineProfile } from "./types.js";

import { readFileSync } from "./safe-fs.js";

const OMLX_MAX_MODEL_MEMORY_GIB_BY_PROFILE: Record<MachineProfile, number> = {
  "mac-mini-16g": 12,
  balanced: 24,
  "macbook-pro-48g": 32,
  "large-128g": 96,
};

function darwinMemoryBytes(): number | null {
  try {
    const out = execSync("sysctl -n hw.memsize", {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function linuxMemoryBytes(): number | null {
  try {
    const meminfo = readFileSync("/proc/meminfo", "utf8");
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(meminfo);
    if (!m?.[1]) return null;
    const kb = Number.parseInt(m[1], 10);
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
    return null;
  } catch {
    return null;
  }
}

/** Total physical memory in bytes, detected per platform. */
export function detectMemoryBytes(): number | null {
  if (process.platform === "darwin") return darwinMemoryBytes();
  if (process.platform === "linux") return linuxMemoryBytes();
  return null;
}

/** Platform-agnostic machine platform identifier. */
export type MachinePlatform = "darwin" | "linux" | "windows" | "other";

/** Map a NodeJS platform string to a MachinePlatform. */
export function platformFromNode(p: NodeJS.Platform): MachinePlatform {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  if (p === "win32") return "windows";
  return "other";
}

/** Descriptive memory tier, separate from the historical profile buckets. */
export type MemoryTier = "16g" | "32g" | "48g" | "64g" | "96g" | "128g+" | "unknown";

/**
 * Classify memory bytes into a descriptive tier. This tier is separate
 * from the platform-specific profile buckets — the profile id keeps its
 * historical values for backward compatibility.
 */
export function memoryTierFromBytes(bytes: number | null): MemoryTier {
  if (bytes === null) return "unknown";
  const GiB = 1024 ** 3;
  if (bytes <= 16 * GiB) return "16g";
  if (bytes <= 32 * GiB) return "32g";
  if (bytes <= 48 * GiB) return "48g";
  if (bytes <= 64 * GiB) return "64g";
  if (bytes <= 96 * GiB) return "96g";
  return "128g+";
}

/** Optional probe fields passed by callers who already know platform/memory. */
export interface MachineProbe {
  platform?: NodeJS.Platform;
  memoryBytes?: number | null;
}

/** Full machine description combining platform, memory tier, and profile. */
export interface MachineDescription {
  platform: MachinePlatform;
  memoryBytes: number | null;
  memoryTier: MemoryTier;
  profile: MachineProfile;
  profileSource: "env" | "detected";
}

/**
 * Describe a machine: platform, memory tier, and profile with source.
 * When probe.memoryBytes is explicitly null, detection is skipped.
 */
export function describeMachine(
  env: NodeJS.ProcessEnv = process.env,
  probe: MachineProbe = {},
): MachineDescription {
  const p = probe.platform ?? platform();
  const memoryBytes = "memoryBytes" in probe ? (probe.memoryBytes ?? null) : detectMemoryBytes();
  const override = normalizeProfile(env["LLAMA_CPP_MACHINE_PROFILE"]);
  const profile = override ?? profileFromMemory(memoryBytes);
  const profileSource = override ? "env" : "detected";
  return {
    platform: platformFromNode(p),
    memoryBytes,
    memoryTier: memoryTierFromBytes(memoryBytes),
    profile,
    profileSource,
  };
}

/** Format a MachineDescription into a single-line summary string. */
export function formatMachineSummary(d: MachineDescription): string {
  const memStr =
    d.memoryBytes === null ? "unknown" : `${(d.memoryBytes / 1024 ** 3).toFixed(1)}GiB`;
  return `platform=${d.platform} memory=${memStr} tier=${d.memoryTier} profile=${d.profile} source=${d.profileSource}`;
}

/**
 * Pick a machine profile from detected memory. The lower thresholds
 * match the historical zsh values exactly so bench records key into
 * the same buckets:
 *   <= 16 GiB  -> mac-mini-16g
 *   <= 32 GiB  -> balanced
 *   <= 64 GiB  -> macbook-pro-48g
 *   > 64 GiB   -> large-128g
 * Unknown memory (non-darwin, detection failure) defaults to
 * macbook-pro-48g to avoid over-restricting context on unidentified
 * hardware.
 */
export function profileFromMemory(memoryBytes: number | null): MachineProfile {
  if (memoryBytes === null) return "macbook-pro-48g";
  if (memoryBytes <= 17_179_869_184) return "mac-mini-16g";
  if (memoryBytes <= 34_359_738_368) return "balanced";
  if (memoryBytes <= 68_719_476_736) return "macbook-pro-48g";
  return "large-128g";
}

/** Normalise any user-facing alias onto the canonical profile name. */
export function normalizeProfile(raw: string | undefined): MachineProfile | null {
  if (!raw) return null;
  switch (raw) {
    case "mac-mini-16g":
    case "mini":
    case "16g":
      return "mac-mini-16g";
    case "balanced":
    case "mid":
      return "balanced";
    case "macbook-pro-48g":
    case "macbook-pro":
    case "mbp":
    case "laptop":
    case "desktop-48g":
    case "desktop":
    case "48g":
    case "best":
      return "macbook-pro-48g";
    case "large-128g":
    case "large":
    case "128g":
      return "large-128g";
    default:
      return null;
  }
}

/**
 * Resolve the active profile from env, falling back to hardware detection.
 * Canonical entry point used by env.resolveEnv and any command that needs
 * the current machine profile without reading the environment directly.
 */
export function resolveProfile(env: NodeJS.ProcessEnv = process.env): MachineProfile {
  const override = normalizeProfile(env["LLAMA_CPP_MACHINE_PROFILE"]);
  if (override) return override;
  return profileFromMemory(detectMemoryBytes());
}

/** Default oMLX max-model-memory cap by machine profile, in GiB. */
export function defaultOmlxMemoryGiBForProfile(profile: MachineProfile): number {
  return OMLX_MAX_MODEL_MEMORY_GIB_BY_PROFILE[profile];
}
