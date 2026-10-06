import { join } from "node:path";

import type { EngineName } from "./engines/index.js";
import type { ResolvedEnv } from "./types.js";

import { modelhostPidFile, readModelHostState } from "./engines/state.js";
import { resolveEnv } from "./env.js";
import {
  type PidIdentityDeps,
  type PidRecordQuery,
  type PidVerdict,
  verifyPidFiles,
} from "./pidIdentity.js";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "./safe-fs.js";
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

/** Append routes for one healthy peer snapshot, deduplicating on model id. */
function appendPeerRoutes(
  routes: ClusterRoute[],
  seenModels: Set<string>,
  peer: ClusterConfigPeer,
  snapshot: PeerSnapshot,
): void {
  let endpoint: URL;
  try {
    endpoint = new URL(peer.endpoint);
  } catch {
    return;
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
      ...(peer.certificate !== undefined ? { certificate: peer.certificate } : {}),
      ...(peer.token !== undefined ? { token: peer.token } : {}),
      targetNodeId: peer.id,
      revision: workload.revision ?? null,
    });
  }
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
    appendPeerRoutes(routes, seenModels, peer, snapshot);
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

export function listLocalWorkloads(
  resolved: ResolvedEnv = resolveEnv(),
  deps?: PidIdentityDeps,
): WorkloadRuntimeEntry[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const dirs: { name: string; pid: number | null; rec: PidRecordQuery | null }[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const pidPath = join(root, dirent.name, "llama-server.pid");
    const modelhostPidPath = join(root, dirent.name, "modelhost.pid");
    const activePidPath = existsSync(pidPath) ? pidPath : modelhostPidPath;
    if (!existsSync(activePidPath)) continue;
    const pid = readPidFile(activePidPath);
    dirs.push({
      name: dirent.name,
      pid,
      rec: pid === null ? null : { recordPath: activePidPath, pid },
    });
  }
  // One batched identity pass: a single ps call covers every recorded pid.
  const verdicts = verifyPidFiles(
    dirs.flatMap((d) => (d.rec === null ? [] : [d.rec])),
    deps,
  );
  return dirs.map((d) => ({
    name: d.name,
    pid: d.pid,
    // "unknown" is represented as not-alive but the entry is still listed —
    // the record was never proven gone.
    alive: d.rec !== null && verdicts.get(d.rec.recordPath) === "alive",
  }));
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

/**
 * Routes for a trusted ModelHost in this workload dir, or null when the
 * state sidecar no longer describes the recorded pid (caller falls through
 * to the ModelRun path). A trusted host with zero aliases yields an empty
 * array — the dir is still "handled" and must not produce ModelRun routes.
 * `verdict` comes from the caller's batched identity pass: only provably
 * gone verdicts ("dead"/"reused") make the host untrusted — "unknown"
 * keeps the record's routes because it may still be our process.
 */
function modelHostRoutesForDir(
  name: string,
  resolved: ResolvedEnv,
  hostPid: number,
  verdict: PidVerdict,
): LocalRoute[] | null {
  if (verdict === "dead" || verdict === "reused") return null;
  const state = readModelHostState({ name }, resolved);
  if (state?.pid !== hostPid) return null;
  const out: LocalRoute[] = [];
  for (const alias of state.modelAliases) {
    out.push({
      workload: name,
      model: alias,
      host: state.host,
      port: state.port,
      engine: state.engine,
      kind: "ModelHost",
      pid: hostPid,
    });
  }
  return out;
}

/** ModelRun routes for one workload dir, given the batched verdict. */
function modelRunRoutesForDir(
  name: string,
  runPid: number,
  verdict: PidVerdict,
  resolved: ResolvedEnv,
): LocalRoute[] {
  if (verdict === "dead" || verdict === "reused") return [];
  const state = readServerState({ name }, resolved);
  if (!state?.rel || !state.host) return [];
  // Route by the model rel AND any `--alias` the server advertises. The
  // server reports its alias (not the rel) on /v1/models, so peer snapshots
  // and clients that use the alias must resolve to a real route rather than
  // falling through to the node's default endpoint (wrong model).
  const models = [state.rel, ...aliasesFromExtraArgs(state.extraArgs)];
  const seen = new Set<string>();
  const out: LocalRoute[] = [];
  for (const model of models) {
    if (!model || seen.has(model)) continue;
    seen.add(model);
    out.push({
      workload: name,
      model,
      host: state.host,
      port: Number(state.port),
      engine: "llamacpp",
      kind: "ModelRun",
      pid: runPid,
    });
  }
  return out;
}

interface DirPidRecords {
  name: string;
  host?: PidRecordQuery;
  run?: PidRecordQuery;
}

function collectPidRecords(
  root: string,
  resolved: ResolvedEnv,
): { dirs: DirPidRecords[]; records: PidRecordQuery[] } {
  const dirs: DirPidRecords[] = [];
  const records: PidRecordQuery[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dr: DirPidRecords = { name: dirent.name };
    const hostPidPath = modelhostPidFile(resolved, { name: dirent.name });
    const hostPid = readPidFile(hostPidPath);
    if (hostPid !== null) {
      dr.host = { recordPath: hostPidPath, pid: hostPid };
      records.push(dr.host);
    }
    const runPidPath = join(root, dirent.name, "llama-server.pid");
    const runPid = readPidFile(runPidPath);
    if (runPid !== null) {
      dr.run = { recordPath: runPidPath, pid: runPid };
      records.push(dr.run);
    }
    dirs.push(dr);
  }
  return { dirs, records };
}

export function listLocalRoutes(
  resolved: ResolvedEnv = resolveEnv(),
  deps?: PidIdentityDeps,
): LocalRoute[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const { dirs, records } = collectPidRecords(root, resolved);
  // One batched identity pass: a single ps call covers every pid file under
  // the runtime dir, so route listing scales with the workload count.
  const verdicts = verifyPidFiles(records, deps);
  const out: LocalRoute[] = [];
  for (const dr of dirs) {
    if (dr.host !== undefined) {
      const hostVerdict = verdicts.get(dr.host.recordPath) ?? "unknown";
      const hostRoutes = modelHostRoutesForDir(dr.name, resolved, dr.host.pid, hostVerdict);
      if (hostRoutes !== null) {
        out.push(...hostRoutes);
        continue;
      }
    }
    if (dr.run !== undefined) {
      const runVerdict = verdicts.get(dr.run.recordPath) ?? "unknown";
      out.push(...modelRunRoutesForDir(dr.name, dr.run.pid, runVerdict, resolved));
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

  const moveIfExists = (src: string, dstName: string): void => {
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
