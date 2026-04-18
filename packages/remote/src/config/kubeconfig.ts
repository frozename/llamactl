import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  ConfigSchema,
  freshConfig,
  LOCAL_NODE_NAME,
  type Config,
  type ClusterNode,
  type Context,
  type User,
} from './schema.js';

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_CONFIG?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'config');
}

export function loadConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) return freshConfig();
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  return ConfigSchema.parse(parsed);
}

export function saveConfig(config: Config, path: string = defaultConfigPath()): void {
  ConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringifyYaml(config);
  writeFileSync(path, yaml, 'utf8');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-POSIX filesystems may reject chmod; cert files elsewhere are
    // the actual secret, so degradation is acceptable.
  }
}

export function currentContext(config: Config): Context {
  const ctx = config.contexts.find((c) => c.name === config.currentContext);
  if (!ctx) {
    throw new Error(`current-context '${config.currentContext}' not found in config.contexts`);
  }
  return ctx;
}

export function resolveNode(
  config: Config,
  nodeName: string,
  contextName?: string,
): { node: ClusterNode; context: Context; user: User } {
  const context = contextName
    ? config.contexts.find((c) => c.name === contextName)
    : currentContext(config);
  if (!context) throw new Error(`context '${contextName}' not found`);
  const cluster = config.clusters.find((c) => c.name === context.cluster);
  if (!cluster) throw new Error(`cluster '${context.cluster}' not found`);
  const node = cluster.nodes.find((n) => n.name === nodeName);
  if (!node) throw new Error(`node '${nodeName}' not found in cluster '${cluster.name}'`);
  const user = config.users.find((u) => u.name === context.user);
  if (!user) throw new Error(`user '${context.user}' not found`);
  return { node, context, user };
}

export function resolveToken(
  user: User,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (user.token) return user.token;
  if (!user.tokenRef) throw new Error(`user '${user.name}' has neither token nor tokenRef`);
  const path = user.tokenRef.replace(/^~(?=$|\/)/, env.HOME ?? homedir());
  if (!existsSync(path)) throw new Error(`tokenRef '${path}' does not exist`);
  return readFileSync(path, 'utf8').trim();
}

export function upsertCluster(config: Config, cluster: Config['clusters'][number]): Config {
  const clusters = config.clusters.filter((c) => c.name !== cluster.name);
  clusters.push(cluster);
  return { ...config, clusters };
}

export function upsertNode(
  config: Config,
  clusterName: string,
  node: ClusterNode,
): Config {
  const clusters = config.clusters.map((c) => {
    if (c.name !== clusterName) return c;
    const nodes = c.nodes.filter((n) => n.name !== node.name);
    nodes.push(node);
    return { ...c, nodes };
  });
  return { ...config, clusters };
}

export function removeNode(
  config: Config,
  clusterName: string,
  nodeName: string,
): Config {
  if (nodeName === LOCAL_NODE_NAME) {
    throw new Error('refusing to remove the local node');
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
