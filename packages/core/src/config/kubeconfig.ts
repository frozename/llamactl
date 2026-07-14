import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteFile } from "../fsAtomic.js";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "../safe-fs.js";
import { llamactlHome, nonEmpty } from "./env.js";
import {
  type ClusterNode,
  type Config,
  ConfigSchema,
  type Context,
  freshConfig,
  LOCAL_NODE_NAME,
  type User,
} from "./schema.js";
import { resolveSecret } from "./secret.js";

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = nonEmpty(env["LLAMACTL_CONFIG"]);
  if (override) return override;
  const base = llamactlHome(env);
  return join(base, "config");
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) return freshConfig();
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as unknown;
  return ConfigSchema.parse(parsed);
}

export function saveConfig(config: Config, path: string = defaultConfigPath()): void {
  ConfigSchema.parse(config);
  const yaml = stringifyYaml(config);
  atomicWriteFile(path, yaml);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems may reject chmod; cert files elsewhere are
    // the actual secret, so degradation is acceptable.
  }
}

/**
 * Serialize a read-modify-write cycle on the kubeconfig behind a
 * pidfile mutex. Both CLI invocations and the long-lived daemon call
 * into the same file, so bare `load -> mutate -> saveConfig` chains
 * race: two writers can each read the same baseline, one saves after
 * the other, and the loser's mutation silently disappears. This
 * wrapper holds a `${path}.lock` pidfile for the entire load / fn /
 * save window, so concurrent callers serialize (bounded 50ms x 40
 * retries wait; then a clear throw) instead of clobbering.
 *
 * `fn` must be synchronous and pure Config->Config — any awaits
 * would extend the critical section unbounded. Callers that need to
 * do async work (network probes, subprocess spawns) must do it
 * BEFORE invoking `mutateConfig`.
 */
export function mutateConfig(path: string, fn: (cfg: Config) => Config): Config {
  const handle = acquireConfigLock(path);
  try {
    const current = loadConfig(path);
    const next = fn(current);
    saveConfig(next, path);
    return next;
  } finally {
    releaseConfigLock(handle);
  }
}

interface ConfigLockHandle {
  path: string;
  fd: number;
  pid: number;
}

const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_RETRIES = 40;

function acquireConfigLock(configPath: string): ConfigLockHandle {
  const lockPath = `${configPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let lastHolder = -1;
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    lastHolder = reapIfStale(lockPath);
    const acquired = tryOpenLock(lockPath);
    if (acquired) return acquired;
    // This synchronous backoff blocks this thread while waiting, by design.
    // Config writes are infrequent and the critical section is short (sub-ms),
    // so bounded contention wait is acceptable and keeps the lock discipline
    // strict even if contention lasts up to ~2,000ms.
    if (attempt < LOCK_MAX_RETRIES - 1) sleepSync(LOCK_RETRY_INTERVAL_MS);
  }
  const totalMs = LOCK_RETRY_INTERVAL_MS * LOCK_MAX_RETRIES;
  const holderNote = lastHolder > 0 ? ` (held by pid=${String(lastHolder)})` : "";
  throw new Error(
    `kubeconfig lock at ${lockPath} still held after ${String(totalMs)}ms${holderNote}`,
  );
}

/**
 * Reap a stale pidfile if the recorded holder is dead.
 * Returns the observed holder pid (`-1` if unreadable or absent).
 *
 * Reaping is intentionally atomic: only one process can rename the stale
 * lockfile away. If another process already replaced or reaped it, this
 * process loses the race and retries the lock-acquire loop.
 *
 * Caveat: if PID `process.kill(pid, 0)` reports a live holder due PID reuse,
 * this function refuses to reap and throws later if lock contention persists.
 * That is fail-closed: better to surface an apparent lock than risk corrupting
 * the kubeconfig. Manual `${configPath}.lock` cleanup is still possible.
 */
function reapIfStale(lockPath: string): number {
  if (!existsSync(lockPath)) return -1;
  const holder = readLockHolder(lockPath);
  if (holder >= 0 && isProcessAlive(holder)) return holder;
  try {
    const reapPath = `${lockPath}.reap-${String(process.pid)}-${String(Date.now() % 1_000_000_000)}`;
    renameSync(lockPath, reapPath);
    try {
      unlinkSync(reapPath);
    } catch {
      // Best-effort cleanup: if removal fails, the stale lock is no longer
      // reachable at lockPath, so correctness is already preserved.
    }
  } catch {
    // Another concurrent acquirer may have already unlinked; the
    // wx open below is the ground truth either way.
  }
  return holder;
}

/** Attempt one exclusive-create open. Returns the handle on success,
 *  null when the lock is contended, throws on any other fs error. */
function tryOpenLock(lockPath: string): ConfigLockHandle | null {
  try {
    const fd = openSync(lockPath, "wx");
    writeSync(fd, String(process.pid));
    return { path: lockPath, fd, pid: process.pid };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return null;
    throw err;
  }
}

function releaseConfigLock(handle: ConfigLockHandle): void {
  try {
    closeSync(handle.fd);
  } catch {
    // Best-effort — unlink below is the authoritative release.
  }
  try {
    const holder = readLockHolder(handle.path);
    if (holder !== handle.pid) return;
    unlinkSync(handle.path);
  } catch {
    // Another process's stale-lock reaper may have removed it first.
  }
}

function readLockHolder(lockPath: string): number {
  try {
    const parsed = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : -1;
  } catch {
    return -1;
  }
}

function isProcessAlive(pid: number): boolean {
  // PID reuse trade-off: a recycled pid can keep a stale lock alive (fail-closed)
  // until the impostor exits. This avoids corrupting config via premature lock theft;
  // operators can clear a stuck `.lock` file manually if needed.
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Block the current thread for `ms` without CPU-spinning.
 * `Atomics.wait` on a fresh SharedArrayBuffer is standard across
 * Bun/Node and doesn't need a runtime-specific sleep primitive.
 */
function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export function currentContext(config: Config): Context {
  const ctx = config.contexts.find((c) => c.name === config.currentContext);
  if (!ctx) {
    throw new Error(`current-context '${config.currentContext}' not found in config.contexts`);
  }
  return ctx;
}

/**
 * Provider-kind virtual node? Shape is `<parent>.<leaf>`.
 * Two flavors today:
 *   * Gateway fanout: `<gateway>.<providerName>` — sirius or
 *     embersynth synthesis. Falls through to the existing
 *     cloud-compat provider path.
 *   * Agent CLI binding: `<agent>.<cli-binding-name>` — Phase 1
 *     of trifold-orchestrating-engelbart. Marked with
 *     `provider.source: 'cli'` so the factory knows to build a
 *     subprocess adapter.
 */
function resolveVirtualProviderNode(
  cluster: Config["clusters"][number],
  nodeName: string,
): ClusterNode | undefined {
  const dot = nodeName.indexOf(".");
  if (dot <= 0 || dot >= nodeName.length - 1) return undefined;
  const parentName = nodeName.slice(0, dot);
  const leafName = nodeName.slice(dot + 1);
  const parent = cluster.nodes.find((n) => n.name === parentName);
  if (!parent) return undefined;
  if (parent.cloud) {
    return {
      name: nodeName,
      endpoint: "",
      kind: "provider",
      provider: { gateway: parentName, providerName: leafName },
    };
  }
  if (parent.cli?.some((b) => b.name === leafName)) {
    return {
      name: nodeName,
      endpoint: "",
      kind: "provider",
      provider: { gateway: parentName, providerName: leafName, source: "cli" },
    };
  }
  return undefined;
}

export function resolveNode(
  config: Config,
  nodeName: string,
  contextName?: string,
): { node: ClusterNode; context: Context; user: User } {
  const context = contextName
    ? config.contexts.find((c) => c.name === contextName)
    : currentContext(config);
  if (!context) throw new Error(`context '${contextName ?? "<default>"}' not found`);
  const cluster = config.clusters.find((c) => c.name === context.cluster);
  if (!cluster) throw new Error(`cluster '${context.cluster}' not found`);
  const user = config.users.find((u) => u.name === context.user);
  if (!user) throw new Error(`user '${context.user}' not found`);

  // Direct match first (agent + gateway nodes).
  const direct = cluster.nodes.find((n) => n.name === nodeName);
  if (direct) return { node: direct, context, user };

  const virtualNode = resolveVirtualProviderNode(cluster, nodeName);
  if (virtualNode) return { node: virtualNode, context, user };

  throw new Error(`node '${nodeName}' not found in cluster '${cluster.name}'`);
}

export function resolveToken(user: User, env: NodeJS.ProcessEnv = process.env): string {
  if (user.token) return user.token;
  if (!user.tokenRef) throw new Error(`user '${user.name}' has neither token nor tokenRef`);
  // Delegate through the unified secret resolver so tokens can live
  // in macOS Keychain / env / file without widening this function.
  return resolveSecret(user.tokenRef, env);
}

/**
 * Resolve a cloud node's API key from its `apiKeyRef`. Thin wrapper
 * around the unified secret resolver — the explicit `apiKeyRef` name
 * stays on the public surface so existing call sites keep reading
 * cleanly. See `config/secret.ts` for the supported reference
 * syntax (`env:` / `$VAR` / `keychain:service/account` / `file:` /
 * legacy bare path).
 *
 * The control plane calls this at request time — the renderer never
 * handles cloud keys, and tokens don't live in kubeconfig YAML
 * alongside non-secret fields.
 */
export function resolveApiKeyRef(apiKeyRef: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolveSecret(apiKeyRef, env);
}

export function upsertCluster(config: Config, cluster: Config["clusters"][number]): Config {
  const clusters = config.clusters.filter((c) => c.name !== cluster.name);
  clusters.push(cluster);
  return { ...config, clusters };
}

export function upsertNode(config: Config, clusterName: string, node: ClusterNode): Config {
  const clusters = config.clusters.map((c) => {
    if (c.name !== clusterName) return c;
    const nodes = c.nodes.filter((n) => n.name !== node.name);
    nodes.push(node);
    return { ...c, nodes };
  });
  return { ...config, clusters };
}

export function removeNode(config: Config, clusterName: string, nodeName: string): Config {
  if (nodeName === LOCAL_NODE_NAME) {
    throw new Error("refusing to remove the local node");
  }
  const clusters = config.clusters.map((c) => {
    if (c.name !== clusterName) return c;
    return { ...c, nodes: c.nodes.filter((n) => n.name !== nodeName) };
  });
  return { ...config, clusters };
}

/** Set the current context's defaultNode. Verifies the node exists. */
export function setDefaultNode(config: Config, nodeName: string): Config {
  const ctx = currentContext(config);
  const cluster = config.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) throw new Error(`cluster '${ctx.cluster}' not found`);
  if (!cluster.nodes.some((n) => n.name === nodeName)) {
    throw new Error(`node '${nodeName}' not found in cluster '${cluster.name}'`);
  }
  return {
    ...config,
    contexts: config.contexts.map((c) =>
      c.name === ctx.name ? { ...c, defaultNode: nodeName } : c,
    ),
  };
}
