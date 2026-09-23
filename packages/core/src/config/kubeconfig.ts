import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { atomicWriteFile } from "../fsAtomic.js";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
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
  // A racing stale-lock reaper can displace our lockfile between acquire
  // and write (see reapIfStale). Re-verify ownership right before
  // saveConfig; on loss, retry the whole read-modify-write against the
  // winner's persisted result instead of clobbering it.
  for (let attempt = 0; attempt < LOCK_LOSS_MAX_ATTEMPTS; attempt++) {
    const handle = acquireConfigLock(path);
    try {
      const next = fn(loadConfig(path));
      const token = readLockToken(handle.path);
      if (token !== null && ownedTokens.has(token)) {
        saveConfig(next, path);
        return next;
      }
    } finally {
      releaseConfigLock(handle);
    }
  }
  throw new Error(
    `kubeconfig lock at ${path}.lock repeatedly displaced by concurrent stale-lock reaping`,
  );
}

interface ConfigLockHandle {
  path: string;
  fd: number;
}

const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_MAX_RETRIES = 40;
const LOCK_LOSS_MAX_ATTEMPTS = 3;

/**
 * Ownership tokens this process has written into the lockfile. The
 * lockfile payload is `${pid}-${nonce}`, not a bare pid: a bare pid
 * cannot distinguish our own lockfile from a foreign one once pid
 * reuse or same-pid workers enter the picture, and a restored lockfile
 * (see reapIfStale) must be recognizable as ours to be reclaimable.
 * Tokens are never removed — a file we released can still resurface as
 * a displaced-and-restored copy, and reclaiming it is how the owner
 * unwinds a zombie instead of leaving a live-pid relic at lockPath.
 */
const ownedTokens = new Set<string>();
let lockTokenCounter = 0;

function acquireConfigLock(configPath: string): ConfigLockHandle {
  const lockPath = `${configPath}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let lastHolder = -1;
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    const reaped = reapIfStale(lockPath);
    if (typeof reaped !== "number") return reaped;
    lastHolder = reaped;
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
 * Returns a planted ConfigLockHandle when this call both reaped the stale
 * file and claimed the freed slot; otherwise returns the observed holder
 * pid (`-1` if unreadable or absent) so the caller can retry or report.
 *
 * The staleness check races with a competing acquirer: after we decide
 * the lockfile is dead, another process can reap it and plant a fresh
 * live lock before our renameSync lands. Unlinking whatever we seized
 * would destroy that live lock and let two mutators into the critical
 * section — the lost-write flake this used to cause. So the seized file
 * is only unlinked when it is verifiably the same dead file we checked
 * (same inode, unchanged contents); anything else is a live or
 * mid-creation lockfile swapped into the window and is restored with an
 * atomic rename. Restoring can only displace a just-planted lockfile
 * whose owner has not verified yet — that owner detects the swap in
 * mutateConfig's pre-write ownership check and retries.
 *
 * Caveat: if PID `process.kill(pid, 0)` reports a live holder due PID reuse,
 * this function refuses to reap and throws later if lock contention persists.
 * That is fail-closed: better to surface an apparent lock than risk corrupting
 * the kubeconfig. Manual `${configPath}.lock` cleanup is still possible.
 */
function reapIfStale(lockPath: string): ConfigLockHandle | number {
  const checked = statIdentity(lockPath);
  if (!checked) return -1;
  const checkedToken = readLockToken(lockPath);
  if (checkedToken !== null && ownedTokens.has(checkedToken)) {
    return adoptOwnedLock(lockPath);
  }
  const holder = readLockHolder(lockPath);
  // A file claiming our pid but carrying a foreign token is a relic from
  // a dead process whose pid was recycled to us — we did not write it,
  // so it is stale for us and safe to reap below.
  if (holder >= 0 && holder !== process.pid && isProcessAlive(holder)) return holder;
  return seizeStaleSlot(lockPath, checked, checkedToken, holder);
}

/**
 * Reclaim a lockfile carrying one of our own tokens — a displaced and
 * restored copy of a lock this process planted. It occupied the slot the
 * whole time, so mutual exclusion never lapsed and reclaiming is safe.
 * This is also how a zombie relic gets cleaned up instead of blocking
 * every contender on a live pid that never releases.
 */
function adoptOwnedLock(lockPath: string): ConfigLockHandle | number {
  try {
    return { path: lockPath, fd: openSync(lockPath, "r") };
  } catch {
    return -1;
  }
}

/**
 * Move the lockfile aside, plant our own lock in the freed slot, then
 * decide what was actually seized. Returns the planted handle when the
 * seized file was verifiably the dead file we checked; otherwise the
 * seized file is restored and the observed holder pid is returned.
 */
function seizeStaleSlot(
  lockPath: string,
  checked: { dev: number; ino: number },
  checkedToken: string | null,
  holder: number,
): ConfigLockHandle | number {
  const reapPath = `${lockPath}.reap-${String(process.pid)}-${String(Date.now() % 1_000_000_000)}`;
  try {
    renameSync(lockPath, reapPath);
  } catch {
    return holder;
  }
  // Plant before inspecting the seized file so no third party can claim
  // the freed slot in the gap and pass verification while a restore is
  // still in flight.
  const plant = tryOpenLock(lockPath);
  const seizedPid = readLockHolder(reapPath);
  if (isCheckedDeadFile(reapPath, checked, checkedToken, seizedPid)) {
    // The seized file is verifiably the dead one we vetted — the only
    // case where unlinking cannot destroy a live lock. If removal fails
    // the stale lock is already unreachable at lockPath, so correctness
    // is preserved either way.
    unlinkQuiet(reapPath);
    return plant ?? holder;
  }
  // The seized file is not the dead one we vetted — put it back. The
  // atomic rename displaces our own plant (or a gap claimant's); every
  // displaced owner re-verifies before writing, and a displaced owner
  // that already released reclaims the restored file on its next pass.
  restoreSeized(reapPath, lockPath);
  if (plant) closeQuiet(plant.fd);
  return seizedPid >= 0 ? seizedPid : holder;
}

/** The seized file is the same dead lockfile we checked: same inode and
 *  unchanged token, and its recorded pid is still dead (or a recycled
 *  pid that is now ours — a foreign-token relic we did not write). */
function isCheckedDeadFile(
  reapPath: string,
  checked: { dev: number; ino: number },
  checkedToken: string | null,
  seizedPid: number,
): boolean {
  const seized = statIdentity(reapPath);
  if (seized?.dev !== checked.dev || seized.ino !== checked.ino) return false;
  if (readLockToken(reapPath) !== checkedToken) return false;
  return seizedPid < 0 || seizedPid === process.pid || !isProcessAlive(seizedPid);
}

/** Put a wrongly-seized lockfile back at lockPath, replacing whatever
 *  claimed the gap — the displaced owner re-verifies before writing. If
 *  the restore itself fails, dropping the seized file still loses only
 *  its path; the owner detects that at the same ownership check. */
function restoreSeized(reapPath: string, lockPath: string): void {
  try {
    renameSync(reapPath, lockPath);
  } catch {
    unlinkQuiet(reapPath);
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Best-effort; callers never rely on the unlink having succeeded.
  }
}

function closeQuiet(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // The fd's inode may already have been replaced by a restore.
  }
}

function statIdentity(path: string): { dev: number; ino: number } | null {
  try {
    const st = lstatSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch {
    return null;
  }
}

/** Attempt one exclusive-create open. Returns the handle on success,
 *  null when the lock is contended, throws on any other fs error. */
function tryOpenLock(lockPath: string): ConfigLockHandle | null {
  try {
    const fd = openSync(lockPath, "wx");
    const token = `${String(process.pid)}-${String(lockTokenCounter++)}-${Math.random()
      .toString(36)
      .slice(2)}`;
    writeSync(fd, token);
    ownedTokens.add(token);
    return { path: lockPath, fd };
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
    const token = readLockToken(handle.path);
    if (token === null || !ownedTokens.has(token)) return;
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

/** Raw lockfile payload — the `${pid}-${nonce}` ownership token. Null
 *  when absent, unreadable, or still empty inside a creator's
 *  open->write window. */
function readLockToken(lockPath: string): string | null {
  try {
    const token = readFileSync(lockPath, "utf8").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
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
