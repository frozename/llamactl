import {
  config as kubecfg,
  createNodeClient,
  LOCAL_NODE_ENDPOINT,
  type NodeClient,
  type TunnelSendFn,
  type Config,
} from '@llamactl/remote';
import { buildTunnelSend, type FetchLike } from './tunnel-dispatch.js';

/**
 * Optional seams for tests: lets a unit test inject a fake kubeconfig
 * + a stubbed fetch without writing YAML + without monkey-patching
 * the global fetch. Production code path ignores these (defaults to
 * disk-backed config + global fetch).
 */
export interface DispatcherTestSeams {
  config?: Config;
  fetchImpl?: FetchLike;
}

let testSeams: DispatcherTestSeams = {};

export function __setTestSeams(seams: DispatcherTestSeams): void {
  testSeams = { ...seams };
}

export function __resetTestSeams(): void {
  testSeams = {};
}

function loadConfigForDispatch(globals: Globals, env: NodeJS.ProcessEnv): Config {
  if (testSeams.config) return testSeams.config;
  const cfgPath = globals.configPath ?? kubecfg.defaultConfigPath(env);
  return kubecfg.loadConfig(cfgPath);
}

/**
 * Build a tunnel-send callable for the given context + node if the
 * node declares `tunnelPreferred: true`. Returns `undefined` when
 * direct HTTPS is the right path (unset / false). Throws with a
 * clear message when the node demands tunneling but the context
 * has no `tunnelCentralUrl` — silent fallback would hit the NAT'd
 * node's direct HTTPS, which the operator already declared
 * unreachable.
 */
function maybeBuildTunnelSend(
  cfg: Config,
  effectiveNodeName: string,
  contextName: string | null,
  env: NodeJS.ProcessEnv,
): TunnelSendFn | undefined {
  const ctxName = contextName ?? cfg.currentContext;
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  if (!ctx) return undefined;
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  if (!cluster) return undefined;
  const node = cluster.nodes.find((n) => n.name === effectiveNodeName);
  if (!node?.tunnelPreferred) return undefined;

  const centralUrl = ctx.tunnelCentralUrl;
  if (!centralUrl) {
    throw new Error(
      `node '${effectiveNodeName}' has tunnelPreferred=true but the ` +
        `current context '${ctx.name}' has no tunnelCentralUrl set; ` +
        `cannot route via reverse tunnel`,
    );
  }

  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) {
    throw new Error(`user '${ctx.user}' not found`);
  }
  // Same bearer the operator's local agent uses to guard direct-HTTPS
  // `/trpc` — the relay endpoint lives on that same local agent, so
  // the same `verifyBearer` check applies.
  const bearer = kubecfg.resolveToken(user, env);

  const sendOpts: Parameters<typeof buildTunnelSend>[0] = {
    centralUrl,
    bearer,
    nodeName: effectiveNodeName,
  };
  if (testSeams.fetchImpl) sendOpts.fetchImpl = testSeams.fetchImpl;
  // Slice C (I.3.7) — pin the relay POST against central's cert if
  // the operator ran `llamactl tunnel pin-central` to populate these
  // fields. Absent fields fail closed inside `callViaTunnelRelay`
  // unless `--insecure-tunnel-relay` was passed on the CLI.
  if (ctx.tunnelCentralCertificate) sendOpts.pinnedCa = ctx.tunnelCentralCertificate;
  if (ctx.tunnelCentralFingerprint) sendOpts.expectedFingerprint = ctx.tunnelCentralFingerprint;
  // `--insecure-tunnel-relay` is a rarely-used bypass flag, so we
  // scan `process.argv` once per tunnel-send build rather than
  // plumbing a new field through the globals parser for every
  // command that might route via the tunnel. Documented choice —
  // keeps the existing Globals surface lean.
  if (isInsecureTunnelRelay()) sendOpts.insecure = true;
  return buildTunnelSend(sendOpts);
}

/**
 * One-shot scan of `process.argv` for the `--insecure-tunnel-relay`
 * bypass flag. Accepts both bare `--insecure-tunnel-relay` and
 * `--insecure-tunnel-relay=true`; anything else (e.g. `=false`) is
 * treated as "not set" so operators can't accidentally leave the
 * flag enabled via env/shell alias with a stale value.
 */
function isInsecureTunnelRelay(argv: readonly string[] = process.argv): boolean {
  for (const raw of argv) {
    if (raw === '--insecure-tunnel-relay') return true;
    if (raw === '--insecure-tunnel-relay=true') return true;
  }
  return false;
}

/**
 * Global flags parsed from argv before subcommand dispatch. Mirrors the
 * kubectl shape:
 *   --node <n>  | -n <n>  → target a specific node from the current context
 *   --context <n>        → override current-context for this invocation
 *   --cluster-config <p> → override the kubeconfig path
 */
export interface Globals {
  nodeName: string | null;
  contextName: string | null;
  configPath: string | null;
}

export const EMPTY_GLOBALS: Globals = {
  nodeName: null,
  contextName: null,
  configPath: null,
};

let currentGlobals: Globals = { ...EMPTY_GLOBALS };

export function setGlobals(g: Globals): void {
  currentGlobals = { ...g };
}

export function getGlobals(): Globals {
  return currentGlobals;
}

export function resetGlobals(): void {
  currentGlobals = { ...EMPTY_GLOBALS };
}

/**
 * Pluck recognised global flags out of argv, leaving everything else in
 * place for the subcommand to consume. Handles `--flag value`,
 * `--flag=value`, and `-n value`. Flags occurring after `--` are left
 * untouched (POSIX convention for pass-through args).
 */
export function extractGlobalFlags(argv: string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = { ...EMPTY_GLOBALS };
  const rest: string[] = [];

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    const split = splitEqFlag(arg);
    const key = split ? split[0] : arg;
    const valueInline = split ? split[1] : undefined;

    if (key === '--node' || key === '-n') {
      const value = valueInline ?? argv[++i];
      if (value === undefined) throw new Error(`${key} requires a value`);
      globals.nodeName = value;
      i++;
      continue;
    }
    if (key === '--context') {
      const value = valueInline ?? argv[++i];
      if (value === undefined) throw new Error(`${key} requires a value`);
      globals.contextName = value;
      i++;
      continue;
    }
    if (key === '--cluster-config') {
      const value = valueInline ?? argv[++i];
      if (value === undefined) throw new Error(`${key} requires a value`);
      globals.configPath = value;
      i++;
      continue;
    }

    rest.push(arg);
    i++;
  }

  return { globals, rest };
}

function splitEqFlag(arg: string): [string, string] | null {
  if (!arg.startsWith('--')) return null;
  const eq = arg.indexOf('=');
  if (eq < 0) return null;
  return [arg.slice(0, eq), arg.slice(eq + 1)];
}

/**
 * Resolve the effective node name, respecting --node and falling back
 * to the current context's defaultNode.
 */
export function resolveEffectiveNodeName(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (globals.nodeName) return globals.nodeName;
  const cfg = loadConfigForDispatch(globals, env);
  const ctxName = globals.contextName ?? cfg.currentContext;
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  return ctx?.defaultNode ?? 'local';
}

/** True when the effective node is the in-process `local` sentinel. */
export function isLocalDispatch(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cfg = loadConfigForDispatch(globals, env);
  const name = resolveEffectiveNodeName(globals, env);
  const ctxName = globals.contextName ?? cfg.currentContext;
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  if (!ctx) return name === 'local';
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === name);
  if (!node) return name === 'local';
  return node.endpoint === LOCAL_NODE_ENDPOINT;
}

/**
 * Build a NodeClient for the effective node. Local nodes short-circuit
 * to in-process dispatch; remote nodes open a pinned-TLS tRPC client.
 * When the target node has `tunnelPreferred: true`, queries +
 * mutations are routed through the context's `tunnelCentralUrl`
 * relay instead of direct HTTPS.
 */
export function getNodeClient(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): NodeClient {
  const cfg = loadConfigForDispatch(globals, env);
  const opts: Parameters<typeof createNodeClient>[1] = {};
  if (globals.nodeName) opts.nodeName = globals.nodeName;
  if (globals.contextName) opts.contextName = globals.contextName;
  opts.env = env;
  const effectiveName = resolveEffectiveNodeName(globals, env);
  const tunnelSend = maybeBuildTunnelSend(
    cfg,
    effectiveName,
    globals.contextName,
    env,
  );
  if (tunnelSend) opts.tunnelSend = tunnelSend;
  return createNodeClient(cfg, opts);
}

export function getNodeClientByName(
  nodeName: string,
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): NodeClient {
  const cfg = loadConfigForDispatch(globals, env);
  const opts: Parameters<typeof createNodeClient>[1] = { nodeName, env };
  if (globals.contextName) opts.contextName = globals.contextName;
  const tunnelSend = maybeBuildTunnelSend(
    cfg,
    nodeName,
    globals.contextName,
    env,
  );
  if (tunnelSend) opts.tunnelSend = tunnelSend;
  return createNodeClient(cfg, opts);
}

/** True when the user passed `--node all` to fan a read out over every
 *  node in the current context. Not a real kubeconfig entry. */
export function isFanOut(globals: Globals = currentGlobals): boolean {
  return globals.nodeName === 'all';
}

export function listContextNodes(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const cfg = loadConfigForDispatch(globals, env);
  const ctxName = globals.contextName ?? cfg.currentContext;
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  if (!ctx) return [];
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  return cluster?.nodes.map((n) => n.name) ?? [];
}

export interface FanOutResult<T> {
  node: string;
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Subscribe to a router streaming procedure via the remote NodeClient,
 * forwarding intermediate events through `onEvent` and returning the
 * final `done` payload. Wires Ctrl-C (SIGINT / SIGTERM) to abort the
 * subscription so the agent's underlying subprocess is signaled and
 * the SSE stream closes cleanly.
 */
export function subscribeRemote<Event, Done>(opts: {
  subscribe: (handlers: {
    onData: (e: unknown) => void;
    onError: (err: unknown) => void;
    onComplete: () => void;
    onStarted?: () => void;
  }) => { unsubscribe: () => void };
  onEvent: (e: Event) => void;
  extractDone: (e: unknown) => Done | null;
}): Promise<Done> {
  return new Promise((resolve, reject) => {
    let finalDone: Done | null = null;
    let settled = false;
    const sub = opts.subscribe({
      onData: (e) => {
        const done = opts.extractDone(e);
        if (done !== null) finalDone = done;
        else opts.onEvent(e as Event);
      },
      onError: (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      },
      onComplete: () => {
        if (settled) return;
        settled = true;
        cleanup();
        if (finalDone !== null) resolve(finalDone);
        else reject(new Error('remote subscription completed without a done event'));
      },
    });
    const abort = () => {
      if (settled) return;
      settled = true;
      sub.unsubscribe();
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
  });
}

/** Convenience: the tRPC router wraps each streaming procedure's
 *  result in a distinct `type: 'done' | 'done-candidate' | …` event.
 *  This helper returns the result payload if the event matches the
 *  given type, or null otherwise. */
export function matchDoneEvent<T>(doneType: string) {
  return (e: unknown): T | null => {
    if (typeof e !== 'object' || e === null) return null;
    const type = (e as { type?: string }).type;
    if (type !== doneType) return null;
    return (e as unknown as { result: T }).result;
  };
}

export async function fanOut<T>(
  perNode: (client: NodeClient, nodeName: string) => Promise<T>,
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FanOutResult<T>[]> {
  const names = listContextNodes(globals, env);
  const settled = await Promise.allSettled(
    names.map(async (n) => {
      const client = getNodeClientByName(n, globals, env);
      return perNode(client, n);
    }),
  );
  return names.map((name, i) => {
    const r = settled[i]!;
    if (r.status === 'fulfilled') return { node: name, ok: true, data: r.value };
    return { node: name, ok: false, error: (r.reason as Error).message };
  });
}

