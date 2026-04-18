import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolveEnv } from './env.js';
import { detectMemoryBytes, resolveProfile } from './profile.js';
import { resolveBuildId } from './build.js';
import type { MachineProfile } from './types.js';

export type GpuKind = 'metal' | 'cuda' | 'rocm' | 'cpu';

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
  platform: string;                    // "darwin-arm64", "linux-x64", ...
  llamaCppBuildId: string | null;
  gpu: GpuInfo | null;
  versions: Versions;
  startedAt: string;                   // ISO-8601
}

// Capture once at module load — the agent's process lifetime matches the
// node's "uptime" from the control plane's perspective, so this is the
// right staleness marker for the reported facts.
const STARTED_AT = new Date().toISOString();

// Hard-coded for now; package.json reads involve tsconfig/import-attrs
// gymnastics that aren't worth it for a version string. Bump here when
// cutting a release.
const LLAMACTL_VERSION = '0.0.0';

export function resolveNodeName(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_NODE_NAME?.trim();
  if (override) return override;
  const host = hostname().trim();
  return host || 'local';
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

export function detectGpu(): GpuInfo | null {
  if (process.platform === 'darwin') return detectMetal();
  if (process.platform === 'linux') {
    return detectNvidia() ?? detectRocm() ?? { kind: 'cpu' };
  }
  return { kind: 'cpu' };
}

function detectMetal(): GpuInfo | null {
  try {
    const raw = execSync('system_profiler SPDisplaysDataType -json', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    const parsed = JSON.parse(raw) as {
      SPDisplaysDataType?: Array<Record<string, unknown>>;
    };
    const first = parsed.SPDisplaysDataType?.[0];
    if (!first) return { kind: 'metal' };
    const name = typeof first['_name'] === 'string' ? (first['_name'] as string) : undefined;
    const vramRaw = typeof first['spdisplays_vram'] === 'string'
      ? (first['spdisplays_vram'] as string)
      : typeof first['spdisplays_vram_shared'] === 'string'
        ? (first['spdisplays_vram_shared'] as string)
        : undefined;
    const memoryMB = vramRaw ? parseHumanToMB(vramRaw) : undefined;
    const info: GpuInfo = { kind: 'metal' };
    if (name) info.name = name;
    if (memoryMB !== undefined) info.memoryMB = memoryMB;
    return info;
  } catch {
    return { kind: 'metal' };
  }
}

function detectNvidia(): GpuInfo | null {
  try {
    const out = execSync(
      'nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits',
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000 },
    ).trim();
    if (!out) return null;
    const firstLine = out.split('\n')[0];
    if (!firstLine) return null;
    const [rawName, rawMem] = firstLine.split(',').map((s) => s.trim());
    const info: GpuInfo = { kind: 'cuda' };
    if (rawName) info.name = rawName;
    const memMB = rawMem ? Number.parseInt(rawMem, 10) : NaN;
    if (Number.isFinite(memMB) && memMB > 0) info.memoryMB = memMB;
    return info;
  } catch {
    return null;
  }
}

function detectRocm(): GpuInfo | null {
  try {
    execSync('rocminfo', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    });
    return { kind: 'rocm' };
  } catch {
    return null;
  }
}

function parseHumanToMB(s: string): number | undefined {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(KB|MB|GB|TB)$/i);
  if (!m || !m[1] || !m[2]) return undefined;
  const num = Number.parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  const factor = unit === 'KB' ? 1 / 1024
    : unit === 'MB' ? 1
      : unit === 'GB' ? 1024
        : /* TB */ 1024 * 1024;
  return Math.round(num * factor);
}

// ----- Version helpers ---------------------------------------------------

function resolveBunVersion(): string {
  // process.versions.bun exists under Bun; under plain Node it's absent.
  const v = (process.versions as Record<string, string | undefined>)['bun'];
  return v ?? 'unknown';
}

function detectLlamaCppRev(env: NodeJS.ProcessEnv): string | null {
  const resolved = safeResolveEnv(env);
  if (!resolved) return null;
  try {
    const out = execSync(
      `git -C ${JSON.stringify(resolved.LLAMA_CPP_SRC)} rev-parse HEAD`,
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 2000 },
    ).trim();
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
    return id === 'unknown' ? null : id;
  } catch {
    return null;
  }
}
