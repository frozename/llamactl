import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type { EngineName } from "./engines/index.js";
import type { ResolvedEnv } from "./types.js";

import { modelhostPidFile, readModelHostState } from "./engines/state.js";
import { resolveEnv } from "./env.js";
import { readServerState } from "./server.js";

export interface WorkloadKey {
  name: string;
}

export interface WorkloadRuntimeEntry {
  name: string;
  pid: number | null;
  alive: boolean;
}

export interface LocalRoute {
  workload: string;
  model: string;
  host: string;
  port: number;
  engine: EngineName;
  kind: "ModelRun" | "ModelHost";
  pid: number;
}

export interface PeerSnapshot {
  /** revision = the peer server's boot token (its /v1/models `created`), used to
   *  invalidate cross-node response caches on a peer restart/swap. Optional for
   *  back-compat with peers that don't advertise it. */
  workloads: { modelId: string; port: number; revision?: string | null }[];
  pressure: "NORMAL" | "HIGH";
  fetchedAt: number;
}

export type ClusterRoute =
  | LocalRoute
  | (Omit<LocalRoute, "pid"> & {
      isPeer: true;
      peerEndpoint: string;
      certificate?: string;
      token?: string;
      targetNodeId: string;
      /** Boot token of the peer's server (its /v1/models `created`); changes on
       *  restart/swap so the proxy can invalidate the cross-node response cache. */
      revision?: string | null;
    });

export interface ClusterConfigPeer {
  id: string;
  endpoint: string;
  certificate?: string;
  token?: string;
}

export interface ClusterConfigLike {
  peers: ClusterConfigPeer[];
}

const PEER_ROUTE_STALE_MS = 30_000;

function endpointPortForUrl(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return url.protocol === "https:" ? 443 : 80;
}

export function listClusterRoutes(
  localRoutes: LocalRoute[],
  peerSnapshots: Map<string, PeerSnapshot>,
  config: ClusterConfigLike,
  now: number = Date.now(),
): ClusterRoute[] {
  const routes: ClusterRoute[] = [...localRoutes];
  const seenModels = new Set(localRoutes.map((route) => route.model));

  for (const peer of config.peers) {
    const snapshot = peerSnapshots.get(peer.id);
    if (!snapshot) continue;
    if (snapshot.pressure === "HIGH") continue;
    if (now - snapshot.fetchedAt > PEER_ROUTE_STALE_MS) continue;

    let endpoint: URL;
    try {
      endpoint = new URL(peer.endpoint);
    } catch {
      continue;
    }

    for (const workload of snapshot.workloads) {
      if (seenModels.has(workload.modelId)) continue;
      seenModels.add(workload.modelId);
      routes.push({
        workload: `${peer.id}:${workload.modelId}`,
        model: workload.modelId,
        host: endpoint.hostname,
        port: endpointPortForUrl(endpoint),
        engine: "llamacpp",
        kind: "ModelRun",
        isPeer: true,
        peerEndpoint: peer.endpoint,
        certificate: peer.certificate,
        token: peer.token,
        targetNodeId: peer.id,
        revision: workload.revision ?? null,
      });
    }
  }

  return routes;
}

export function workloadRuntimeRoot(resolved: ResolvedEnv = resolveEnv()): string {
  return join(resolved.LOCAL_AI_RUNTIME_DIR, "workloads");
}

export function workloadRuntimeDir(resolved: ResolvedEnv, key: WorkloadKey): string {
  return join(workloadRuntimeRoot(resolved), key.name);
}

export function ensureWorkloadRuntimeDir(resolved: ResolvedEnv, key: WorkloadKey): string {
  const dir = workloadRuntimeDir(resolved, key);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function listLocalWorkloads(resolved: ResolvedEnv = resolveEnv()): WorkloadRuntimeEntry[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const entries: WorkloadRuntimeEntry[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pidPath = join(root, dirent.name, "llama-server.pid");
    const modelhostPidPath = join(root, dirent.name, "modelhost.pid");
    const activePidPath = existsSync(pidPath) ? pidPath : modelhostPidPath;
    if (!existsSync(activePidPath)) continue;
    const pid = readPidFile(activePidPath);
    entries.push({ name: dirent.name, pid, alive: pid !== null && isProcessAlive(pid) });
  }
  return entries;
}

// Extract `--alias`/`-a` values from llama-server extraArgs. Inlined here (not
// imported from server.ts) to avoid a circular module dependency.
function aliasesFromExtraArgs(extraArgs: readonly string[] | undefined): string[] {
  if (!extraArgs) return [];
  const out: string[] = [];
  for (let i = 0; i + 1 < extraArgs.length; i += 1) {
    const value = extraArgs[i + 1];
    if ((extraArgs[i] === "--alias" || extraArgs[i] === "-a") && value !== undefined) {
      out.push(value);
    }
  }
  return out;
}

export function listLocalRoutes(resolved: ResolvedEnv = resolveEnv()): LocalRoute[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const out: LocalRoute[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const key = { name: dirent.name };

    const hostPid = readPidFile(modelhostPidFile(resolved, key));
    if (hostPid !== null && isProcessAlive(hostPid)) {
      const state = readModelHostState(key, resolved);
      if (state?.pid === hostPid) {
        for (const alias of state.modelAliases) {
          out.push({
            workload: dirent.name,
            model: alias,
            host: state.host,
            port: state.port,
            engine: state.engine,
            kind: "ModelHost",
            pid: hostPid,
          });
        }
        continue;
      }
    }

    const runPid = readPidFile(join(root, dirent.name, "llama-server.pid"));
    if (runPid === null || !isProcessAlive(runPid)) continue;
    const state = readServerState(key, resolved);
    if (!state?.rel || !state.host) continue;
    // Route by the model rel AND any `--alias` the server advertises. The
    // server reports its alias (not the rel) on /v1/models, so peer snapshots
    // and clients that use the alias must resolve to a real route rather than
    // falling through to the node's default endpoint (wrong model).
    const models = [state.rel, ...aliasesFromExtraArgs(state.extraArgs)];
    const seen = new Set<string>();
    for (const model of models) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      out.push({
        workload: dirent.name,
        model,
        host: state.host,
        port: Number(state.port),
        engine: "llamacpp",
        kind: "ModelRun",
        pid: runPid,
      });
    }
  }
  return out;
}

export function listWorkloadDirs(resolved: ResolvedEnv = resolveEnv()): string[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (dirent.isDirectory()) out.push(dirent.name);
  }
  return out;
}

export type MigrationResult =
  | { kind: "skipped" }
  | { kind: "no-legacy" }
  | { kind: "migrated"; workload: string }
  | { kind: "synthesized"; workload: string };

interface MinimalManifestForMigration {
  metadata: { name: string };
  spec: {
    node: string;
    target: { kind: "rel" | "alias"; value: string };
    endpoint?: { host?: string; port?: number };
  };
}

export function migrateLegacySingletonRuntime(
  resolved: ResolvedEnv,
  manifests: MinimalManifestForMigration[],
): MigrationResult {
  const root = resolved.LOCAL_AI_RUNTIME_DIR;
  const flag = join(root, ".migrated-v2");
  if (existsSync(flag)) return { kind: "skipped" };

  const legacyPid = join(root, "llama-server.pid");
  const legacyState = join(root, "llama-server.state");
  const legacyLog = join(root, "llama-server.log");
  if (!existsSync(legacyPid) && !existsSync(legacyState)) {
    writeFileSync(flag, "");
    return { kind: "no-legacy" };
  }

  let stateRel: string | null = null;
  let statePort: number | null = null;
  try {
    const raw = readFileSync(legacyState, "utf8");
    const parsed = JSON.parse(raw) as { rel?: unknown; port?: unknown };
    if (typeof parsed.rel === "string") stateRel = parsed.rel;
    if (typeof parsed.port === "string") statePort = Number.parseInt(parsed.port, 10);
    if (typeof parsed.port === "number") statePort = parsed.port;
  } catch {
    // Legacy sidecar may be absent or malformed; migration can still move raw files.
  }

  const match = manifests.find(
    (manifest) =>
      manifest.spec.target.value === stateRel &&
      (manifest.spec.endpoint?.port === undefined || manifest.spec.endpoint.port === statePort),
  );

  const workloadName = match?.metadata.name ?? `imperative-${String(Date.now())}`;
  const destDir = ensureWorkloadRuntimeDir(resolved, { name: workloadName });

  const moveIfExists = (src: string, dstName: string) => {
    if (existsSync(src)) {
      try {
        renameSync(src, join(destDir, dstName));
      } catch {
        // Best-effort migration leaves the original file in place if a move fails.
      }
    }
  };
  moveIfExists(legacyPid, "llama-server.pid");
  moveIfExists(legacyState, "llama-server.state");
  moveIfExists(legacyLog, "llama-server.log");

  writeFileSync(flag, "");
  return match
    ? { kind: "migrated", workload: workloadName }
    : { kind: "synthesized", workload: workloadName };
}
