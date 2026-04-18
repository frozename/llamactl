import {
  config as kubecfg,
  createNodeClient,
  LOCAL_NODE_ENDPOINT,
  type NodeClient,
} from '@llamactl/remote';

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
  const cfgPath = globals.configPath ?? kubecfg.defaultConfigPath(env);
  const cfg = kubecfg.loadConfig(cfgPath);
  const ctxName = globals.contextName ?? cfg.currentContext;
  const ctx = cfg.contexts.find((c) => c.name === ctxName);
  return ctx?.defaultNode ?? 'local';
}

/** True when the effective node is the in-process `local` sentinel. */
export function isLocalDispatch(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cfgPath = globals.configPath ?? kubecfg.defaultConfigPath(env);
  const cfg = kubecfg.loadConfig(cfgPath);
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
 */
export function getNodeClient(
  globals: Globals = currentGlobals,
  env: NodeJS.ProcessEnv = process.env,
): NodeClient {
  const cfgPath = globals.configPath ?? kubecfg.defaultConfigPath(env);
  const cfg = kubecfg.loadConfig(cfgPath);
  const opts: Parameters<typeof createNodeClient>[1] = {};
  if (globals.nodeName) opts.nodeName = globals.nodeName;
  if (globals.contextName) opts.contextName = globals.contextName;
  opts.env = env;
  return createNodeClient(cfg, opts);
}

