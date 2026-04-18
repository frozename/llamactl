import { createOpenAICompatProvider, type AiProvider } from '@llamactl/nova';
import {
  DEFAULT_CLOUD_BASE_URLS,
  type ClusterNode,
  type CloudBinding,
  type CloudProvider,
} from '../config/schema.js';
import { resolveApiKeyRef } from '../config/kubeconfig.js';

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
  const apiKey = resolveApiKeyRef(node.cloud.apiKeyRef, env);
  return createOpenAICompatProvider({
    name: node.name,
    displayName: node.cloud.displayName ?? node.name,
    baseUrl: node.cloud.baseUrl,
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
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
