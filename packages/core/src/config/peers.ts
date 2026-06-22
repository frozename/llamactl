import { currentContext, loadConfig, resolveToken } from "./kubeconfig.js";
import { type ClusterNode, type Config, LOCAL_NODE_ENDPOINT, LOCAL_NODE_NAME } from "./schema.js";

export interface PeerNode {
  id: string;
  endpoint: string;
  certificate?: string;
  fingerprint?: string;
  tokenRef?: string;
  token?: string;
  tunnelPreferred?: boolean;
  tunnelCentralUrl?: string;
  tunnelCentralCertificate?: string;
  tunnelCentralFingerprint?: string;
  tunnelRelayTokenRef?: string;
  tunnelRelayToken?: string;
  tunnelNodeName?: string;
}

function isAgentNode(node: ClusterNode): boolean {
  return (node.kind ?? "agent") === "agent";
}

function isHttpsEndpoint(endpoint: string): boolean {
  if (!endpoint.trim()) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:";
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
      ...(node.certificate !== undefined ? { certificate: node.certificate } : {}),
      ...(node.certificateFingerprint !== undefined
        ? { fingerprint: node.certificateFingerprint }
        : {}),
      ...(contextUser?.tokenRef !== undefined ? { tokenRef: contextUser.tokenRef } : {}),
      ...(resolvedToken !== undefined ? { token: resolvedToken } : {}),
      ...(node.tunnelPreferred !== undefined ? { tunnelPreferred: node.tunnelPreferred } : {}),
      ...(context.tunnelCentralUrl !== undefined
        ? { tunnelCentralUrl: context.tunnelCentralUrl }
        : {}),
      ...(context.tunnelCentralCertificate !== undefined
        ? { tunnelCentralCertificate: context.tunnelCentralCertificate }
        : {}),
      ...(context.tunnelCentralFingerprint !== undefined
        ? { tunnelCentralFingerprint: context.tunnelCentralFingerprint }
        : {}),
      ...(contextUser?.tokenRef !== undefined ? { tunnelRelayTokenRef: contextUser.tokenRef } : {}),
      ...(resolvedToken !== undefined ? { tunnelRelayToken: resolvedToken } : {}),
      ...(node.tunnelNodeName !== undefined ? { tunnelNodeName: node.tunnelNodeName } : {}),
    }));
}
