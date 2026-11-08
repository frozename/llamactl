import { basename, join } from "node:path";

import type { EngineName } from "./engines/index.js";
import type { QualificationStage } from "./routing/capabilities.js";
import type { ResolvedEnv } from "./types.js";

import { listCatalog } from "./catalog.js";
import { modelhostPidFile, readModelHostState } from "./engines/state.js";
import { resolveEnv } from "./env.js";
import {
  type PidIdentityDeps,
  type PidRecordQuery,
  type PidVerdict,
  verifyPidFiles,
} from "./pidIdentity.js";
import { isExperimentalRoute, QUALIFICATION_LABEL } from "./routing/capabilities.js";
import {
  existsSync,
  lstatSync,
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
  /** Labels carried alongside the route (#518); the qualification label
   *  (llamactl.io/qualification) can flag a route experimental. */
  labels?: Readonly<Record<string, string>>;
  /** Catalog qualification stage joined by the route's rel/model id (#518).
   *  Carried as a plain string so hand-built routes and inherited peer
   *  stages need no cast; catalog rows and advertisements validate the
   *  stage against QUALIFICATION_STAGES at their own boundaries. */
  qualificationStage?: string;
}

export interface PeerSnapshot {
  /** revision = the peer workload's boot token: its runtime-record epoch when
   *  llamactl manages it, else its /v1/models `created` once two consecutive
   *  reads agree, null otherwise. Used to invalidate cross-node response
   *  caches on a peer restart/swap. Optional for back-compat with peers that
   *  don't advertise it. */
  workloads: {
    modelId: string;
    port: number;
    revision?: string | null;
    /** Peer-advertised labels (#518); the qualification label can flag the
     *  peer route experimental so an experimental-only id stays shadowed. */
    labels?: Record<string, string>;
  }[];
  pressure: "NORMAL" | "HIGH";
  fetchedAt: number;
}

export type ClusterRoute =
  | LocalRoute
  | (Omit<LocalRoute, "pid"> & {
      isPeer: true;
      peerEndpoint: string;
      certificate?: string;
      tlsServerName?: string;
      token?: string;
      targetNodeId: string;
      /** Boot token of the peer's workload: its runtime-record epoch when
       *  llamactl manages it, else its /v1/models `created` once two
       *  consecutive reads agree, null otherwise; changes on restart/swap so
       *  the proxy can invalidate the cross-node response cache. */
      revision?: string | null;
    });

export interface ClusterConfigPeer {
  id: string;
  endpoint: string;
  certificate?: string;
  tlsServerName?: string;
  token?: string;
}

export interface ClusterConfigLike {
  peers: ClusterConfigPeer[];
}

const PEER_ROUTE_STALE_MS = 30_000;

/** Resolved path of the operator's custom catalog file, honouring
 *  LOCAL_AI_CUSTOM_CATALOG_FILE then the runtime-dir default. Never reads
 *  process.env — the ResolvedEnv is the only input. */
export function customCatalogFileFor(resolved: ResolvedEnv): string {
  const file = resolved.LOCAL_AI_CUSTOM_CATALOG_FILE;
  if (!file) return join(resolved.LOCAL_AI_RUNTIME_DIR, "curated-models.tsv");
  return file;
}

/**
 * Qualification stage per catalog rel, builtin rows first so the last row
 * per rel wins and custom rows override builtins (#518). A later row without
 * a qualification clears an earlier one.
 */
export function catalogQualificationStages(resolved: ResolvedEnv): Map<string, QualificationStage> {
  const stages = new Map<string, QualificationStage>();
  for (const row of listCatalog("all", { customCatalogFile: customCatalogFileFor(resolved) })) {
    const stage = row.qualification?.stage;
    if (stage === undefined) stages.delete(row.rel);
    else stages.set(row.rel, stage);
  }
  return stages;
}

/** Join the catalog stage onto one dir's routes. The key is the first
 *  route's model only — state.rel for ModelRun, modelAliases[0] for
 *  ModelHost — so aliases never match catalog rows (#518). */
function withCatalogStages(
  routes: LocalRoute[],
  stageByModel: ReadonlyMap<string, QualificationStage>,
): LocalRoute[] {
  const key = routes[0]?.model;
  const stage = key === undefined ? undefined : stageByModel.get(key);
  if (stage === undefined) return routes;
  return routes.map((route) => ({ ...route, qualificationStage: stage }));
}

function endpointPortForUrl(url: URL): number {
  if (url.port) {
    const parsed = Number.parseInt(url.port, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return url.protocol === "https:" ? 443 : 80;
}

interface PeerAdmissionHolder {
  /** True while every admitted route for this model id is experimental. */
  experimentalOnly: boolean;
  /** Qualification stage of the first local route for this id, inherited by
   *  unlabeled peer routes when stageByModel has no entry (#518). */
  stage?: string;
}

function seedPeerHolders(localRoutes: readonly LocalRoute[]): Map<string, PeerAdmissionHolder> {
  const holders = new Map<string, PeerAdmissionHolder>();
  for (const route of localRoutes) {
    const holder = holders.get(route.model);
    if (holder === undefined) {
      holders.set(route.model, {
        experimentalOnly: isExperimentalRoute(route),
        ...(route.qualificationStage !== undefined ? { stage: route.qualificationStage } : {}),
      });
    } else if (!isExperimentalRoute(route)) {
      holder.experimentalOnly = false;
    }
  }
  return holders;
}

/** Copy peer labels only when they are a plain object of string values.
 *  The runtime guards cover a remote snapshot whose JSON carries null or
 *  non-string values despite the declared type. */
function sanitizePeerLabels(
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!labels || Object.getPrototypeOf(labels) !== Object.prototype) {
    return undefined;
  }
  for (const value of Object.values(labels)) {
    if (typeof value !== "string") return undefined;
  }
  return { ...labels };
}

/**
 * #518 admission: a route is admitted when no route exists for its id yet,
 * or when the id is held only by experimental routes and this route is not
 * experimental (the holder then flips to mixed). An experimental route for
 * an id with a non-experimental holder is skipped, so experimental never
 * shadows a stable route.
 */
function admitPeerRoute(
  holders: Map<string, PeerAdmissionHolder>,
  route: { model: string; labels?: Readonly<Record<string, string>>; qualificationStage?: string },
): boolean {
  const holder = holders.get(route.model);
  const experimental = isExperimentalRoute(route);
  if (holder === undefined) {
    holders.set(route.model, { experimentalOnly: experimental });
    return true;
  }
  if (holder.experimentalOnly && !experimental) {
    holder.experimentalOnly = false;
    return true;
  }
  return false;
}

function peerTlsFields(peer: ClusterConfigPeer): {
  certificate?: string;
  tlsServerName?: string;
  token?: string;
} {
  return {
    ...(peer.certificate !== undefined ? { certificate: peer.certificate } : {}),
    ...(peer.tlsServerName !== undefined ? { tlsServerName: peer.tlsServerName } : {}),
    ...(peer.token !== undefined ? { token: peer.token } : {}),
  };
}

/** Append routes for one healthy peer snapshot, admitting per #518.
 *  Unlabeled peer routes inherit a qualification stage (stageByModel first,
 *  then the first local route's stage), so a peer serving a locally
 *  experimental id stays shadowed; an explicit peer label always beats the
 *  inherited stage. */
function appendPeerRoutes(
  routes: ClusterRoute[],
  holders: Map<string, PeerAdmissionHolder>,
  peer: ClusterConfigPeer,
  snapshot: PeerSnapshot,
  stageByModel: ReadonlyMap<string, string> | undefined,
): void {
  let endpoint: URL;
  try {
    endpoint = new URL(peer.endpoint);
  } catch {
    return;
  }

  for (const workload of snapshot.workloads) {
    const labels = sanitizePeerLabels(workload.labels);
    // An explicit peer qualification label beats any inherited stage.
    const inherited =
      labels?.[QUALIFICATION_LABEL] === undefined
        ? (stageByModel?.get(workload.modelId) ?? holders.get(workload.modelId)?.stage)
        : undefined;
    const route: ClusterRoute = {
      workload: `${peer.id}:${workload.modelId}`,
      model: workload.modelId,
      host: endpoint.hostname,
      port: endpointPortForUrl(endpoint),
      engine: "llamacpp",
      kind: "ModelRun",
      isPeer: true,
      peerEndpoint: peer.endpoint,
      ...peerTlsFields(peer),
      targetNodeId: peer.id,
      revision: workload.revision ?? null,
      ...(labels !== undefined ? { labels } : {}),
      ...(inherited !== undefined ? { qualificationStage: inherited } : {}),
    };
    if (!admitPeerRoute(holders, route)) continue;
    routes.push(route);
  }
}

/**
 * Merge local and peer routes for cluster routing.
 *
 * `opts.stageByModel` is keyed by the exact model id only — there is no
 * basename(rel) alias matching, so a peer advertising a basename alias of a
 * locally experimental rel does not inherit the stage. Known limitation
 * tracked by the #518 follow-up (create-proxy) alongside the legacyWinner
 * divergence documented on RouteCandidate in routing/catalog.ts.
 */
export function listClusterRoutes(
  localRoutes: LocalRoute[],
  peerSnapshots: Map<string, PeerSnapshot>,
  config: ClusterConfigLike,
  now: number = Date.now(),
  opts: { stageByModel?: ReadonlyMap<string, string> } = {},
): ClusterRoute[] {
  const routes: ClusterRoute[] = [...localRoutes];
  const holders = seedPeerHolders(localRoutes);

  for (const peer of config.peers) {
    const snapshot = peerSnapshots.get(peer.id);
    if (!snapshot) continue;
    if (snapshot.pressure === "HIGH") continue;
    if (now - snapshot.fetchedAt > PEER_ROUTE_STALE_MS) continue;
    appendPeerRoutes(routes, holders, peer, snapshot, opts.stageByModel);
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

function dirPidRecords(root: string, name: string, resolved: ResolvedEnv): DirPidRecords {
  const dr: DirPidRecords = { name };
  const hostPidPath = modelhostPidFile(resolved, { name });
  const hostPid = readPidFile(hostPidPath);
  if (hostPid !== null) dr.host = { recordPath: hostPidPath, pid: hostPid };
  const runPidPath = join(root, name, "llama-server.pid");
  const runPid = readPidFile(runPidPath);
  if (runPid !== null) dr.run = { recordPath: runPidPath, pid: runPid };
  return dr;
}

function recordsOf(dr: DirPidRecords): PidRecordQuery[] {
  return [dr.host, dr.run].filter((rec) => rec !== undefined);
}

function routesForDir(
  dr: DirPidRecords,
  verdicts: ReadonlyMap<string, PidVerdict>,
  resolved: ResolvedEnv,
): LocalRoute[] {
  if (dr.host !== undefined) {
    const hostVerdict = verdicts.get(dr.host.recordPath) ?? "unknown";
    const hostRoutes = modelHostRoutesForDir(dr.name, resolved, dr.host.pid, hostVerdict);
    if (hostRoutes !== null) return hostRoutes;
  }
  if (dr.run === undefined) return [];
  const runVerdict = verdicts.get(dr.run.recordPath) ?? "unknown";
  return modelRunRoutesForDir(dr.name, dr.run.pid, runVerdict, resolved);
}

export function listLocalRoutes(
  resolved: ResolvedEnv = resolveEnv(),
  deps?: PidIdentityDeps,
): LocalRoute[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirPidRecords(root, dirent.name, resolved));
  // One batched identity pass: a single ps call covers every pid file under
  // the runtime dir, so route listing scales with the workload count.
  const verdicts = verifyPidFiles(
    dirs.flatMap((dr) => recordsOf(dr)),
    deps,
  );
  const stageByModel = catalogQualificationStages(resolved);
  return dirs.flatMap((dr) =>
    withCatalogStages(routesForDir(dr, verdicts, resolved), stageByModel),
  );
}

/**
 * listLocalRoutes for one workload: only that workload's pid records are
 * verified, so re-checking one deployment does not pay an identity pass
 * over every workload. A name listLocalRoutes would never read, anything
 * but a directory directly under the runtime root, lists nothing.
 */
export function listWorkloadRoutes(
  resolved: ResolvedEnv,
  name: string,
  deps?: PidIdentityDeps,
): LocalRoute[] {
  const root = workloadRuntimeRoot(resolved);
  if (name === "" || name === "." || name === ".." || basename(name) !== name) return [];
  // lstat throws on a NUL byte rather than reporting no entry.
  if (name.includes("\0")) return [];
  if (lstatSync(join(root, name), { throwIfNoEntry: false })?.isDirectory() !== true) return [];
  const dr = dirPidRecords(root, name, resolved);
  return withCatalogStages(
    routesForDir(dr, verifyPidFiles(recordsOf(dr), deps), resolved),
    catalogQualificationStages(resolved),
  );
}

export function listWorkloadDirs(resolved: ResolvedEnv = resolveEnv()): string[] {
  const root = workloadRuntimeRoot(resolved);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (dirent.isDirectory()) out.push(dirent.name);
  }
  // readdir order is filesystem-defined (hash order on ext4, creation order
  // on tmpfs); sort so callers' messages and picks are deterministic.
  return out.sort();
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
