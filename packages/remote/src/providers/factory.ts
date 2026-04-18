import { createOpenAICompatProvider, type AiProvider } from '@llamactl/nova';
import {
  DEFAULT_CLOUD_BASE_URLS,
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
  type ClusterNode,
  type CloudBinding,
  type CloudProvider,
  type User,
} from '../config/schema.js';
import { resolveApiKeyRef, resolveToken } from '../config/kubeconfig.js';
import type { PinnedFetchFactory } from '../client/links.js';

/**
 * Factory that turns a kubeconfig cloud node + resolved API key into
 * a materialised `AiProvider`. Dialect-diverging providers (Anthropic
 * native, Cohere, Gemini) will branch here as their adapters land;
 * today every supported provider speaks OpenAI-compatible.
 */
export function providerForCloudNode(
  node: ClusterNode,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof globalThis.fetch,
): AiProvider {
  if (!node.cloud) {
    throw new Error(`node '${node.name}' is not a cloud node`);
  }
  // Anonymous gateway (sirius on localhost, a dev llama-server, etc.)
  // is allowed when `apiKeyRef` is unset — pass an empty key and the
  // OpenAI-compat adapter sends a vacuous `Authorization` header that
  // unauthenticated upstreams ignore.
  const apiKey = node.cloud.apiKeyRef
    ? resolveApiKeyRef(node.cloud.apiKeyRef, env)
    : '';
  return createOpenAICompatProvider({
    name: node.name,
    displayName: node.cloud.displayName ?? node.name,
    baseUrl: node.cloud.baseUrl,
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

/**
 * Unified provider factory — works for both kinds of node:
 *
 *   - `cloud`: delegates to `providerForCloudNode` above; talks to the
 *     registered upstream (OpenAI, Anthropic, etc.) directly.
 *   - `agent`: points `createOpenAICompatProvider` at the agent's
 *     `/v1` gateway. The agent's bearer token becomes the adapter's
 *     API key; a pinned-TLS fetch factory (undici on Node, Bun's
 *     native `tls.ca` on CLI) carries the self-signed cert.
 *
 * Local (`inproc://`) nodes are transparent: they reuse the agent
 * path against whatever `http://host:port` the in-process llama-server
 * is listening on, but through tRPC's local caller rather than HTTPS.
 * The caller who wants a local provider should prefer the core
 * `openaiProxy` directly — this helper assumes an HTTP endpoint.
 */
export function providerForNode(opts: {
  node: ClusterNode;
  user: User;
  env?: NodeJS.ProcessEnv;
  /** Runtime-specific pinned-fetch factory for agent nodes. Omit for
   *  CLI (Bun's native fetch picks up `tls.ca` from the link layer).
   *  Electron main passes `makeNodePinnedFetch`. */
  fetchFactory?: PinnedFetchFactory;
}): AiProvider {
  const { node, user, env = process.env, fetchFactory } = opts;
  const kind = resolveNodeKind(node);
  if (kind === 'cloud') return providerForCloudNode(node, env);

  if (node.endpoint === LOCAL_NODE_ENDPOINT) {
    throw new Error(
      `providerForNode: local (inproc) nodes have no HTTP endpoint — call core.openaiProxy directly`,
    );
  }
  const token = resolveToken(user, env);
  const baseUrl = node.endpoint.replace(/\/$/, '') + '/v1';
  const fetchImpl = fetchFactory ? fetchFactory(node) : undefined;
  return createOpenAICompatProvider({
    name: node.name,
    displayName: node.name,
    baseUrl,
    apiKey: token,
    ...(fetchImpl ? { fetch: fetchImpl as typeof globalThis.fetch } : {}),
  });
}

/**
 * Pre-fill a cloud-binding scaffold for a given provider. UIs use
 * this to drive the registration form — user picks a provider, gets
 * the canonical base URL, and only types the API key reference.
 */
export function defaultCloudBinding(
  provider: CloudProvider,
  apiKeyRef: string,
  overrides: Partial<CloudBinding> = {},
): CloudBinding {
  return {
    provider,
    baseUrl: DEFAULT_CLOUD_BASE_URLS[provider] || '',
    apiKeyRef,
    ...overrides,
  };
}
