import { currentContext, loadConfig, resolveToken } from './kubeconfig.js';
import {
  LOCAL_NODE_ENDPOINT,
  LOCAL_NODE_NAME,
  type ClusterNode,
  type Config,
} from './schema.js';

export interface PeerNode {
  id: string;
  endpoint: string;
  certificate?: string;
  fingerprint?: string;
  tokenRef?: string;
  token?: string;
}

function isAgentNode(node: ClusterNode): boolean {
  return (node.kind ?? 'agent') === 'agent';
}

function isHttpsEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function readConfiguredToken(config: Config): string | undefined {
  const context = currentContext(config);
  const user = config.users.find((candidate) => candidate.name === context.user);
  if (!user) return undefined;
  if (user.token) return user.token;
  try {
    return resolveToken(user);
  } catch {
    return undefined;
  }
}

export function listPeers(opts?: { currentNodeName?: string }): PeerNode[] {
  const config = loadConfig();
  const context = currentContext(config);
  const cluster = config.clusters.find((candidate) => candidate.name === context.cluster);
  if (!cluster) return [];

  const localNodeName = opts?.currentNodeName ?? LOCAL_NODE_NAME;
  const resolvedToken = readConfiguredToken(config);
  const contextUser = config.users.find((user) => user.name === context.user);

  return cluster.nodes
    .filter((node) => isAgentNode(node))
    .filter((node) => node.name !== localNodeName && node.endpoint !== LOCAL_NODE_ENDPOINT)
    .filter((node) => isHttpsEndpoint(node.endpoint))
    .map((node) => ({
      id: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate,
      fingerprint: node.certificateFingerprint,
      tokenRef: contextUser?.tokenRef,
      token: resolvedToken,
    }));
}

