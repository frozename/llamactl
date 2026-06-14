import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

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
  const override = nonEmpty(env.LLAMACTL_CONFIG);
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
  mkdirSync(dirname(path), { recursive: true });
  const yaml = stringifyYaml(config);
  writeFileSync(path, yaml, "utf8");
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
