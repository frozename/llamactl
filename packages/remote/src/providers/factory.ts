import { createOpenAICompatProvider, type AiProvider } from '@nova/contracts';
import {
  DEFAULT_CLOUD_BASE_URLS,
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
  type ClusterNode,
  type CloudBinding,
  type CloudProvider,
  type Config,
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
  const providerName: CloudProvider = node.cloud.provider;
  const baseUrl = normalizeOpenAICompatBaseUrl(
    node.cloud.baseUrl || DEFAULT_CLOUD_BASE_URLS[providerName] || '',
    providerName,
  );
  const base = createOpenAICompatProvider({
    name: node.name,
    displayName: node.cloud.displayName ?? node.name,
    baseUrl,
    apiKey,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return applyProviderQuirks(base, providerName);
}

/**
 * Non-OpenAI-compat quirks layered on top of the generic adapter so
 * providers that diverge from the spec keep the single-factory shape.
 *
 *   gemini     — Google's OpenAI-compat shim returns models with
 *                `id: "models/gemini-2.5-flash"` from /v1/models but
 *                rejects that same string when echoed back in
 *                /chat/completions with "model is not specified".
 *                Strip the `models/` prefix before forwarding.
 *   anthropic  — listing models via `GET /v1/models` needs
 *                `x-api-key` + `anthropic-version` headers, NOT the
 *                `Authorization: Bearer` the adapter sends. We fall
 *                back to a known-good hardcoded catalog when the
 *                upstream returns empty / 401 / 404 so the chat UI
 *                can still pick a model to talk to.
 */
function applyProviderQuirks(
  base: AiProvider,
  providerName: CloudProvider,
): AiProvider {
  if (providerName !== 'gemini' && providerName !== 'anthropic') return base;

  const stripGeminiPrefix = (value: string | undefined): string | undefined =>
    typeof value === 'string' && value.startsWith('models/')
      ? value.slice('models/'.length)
      : value;

  const transformRequest = <T extends { model?: string } | undefined>(req: T): T => {
    if (providerName !== 'gemini' || !req || !req.model) return req;
    return { ...req, model: stripGeminiPrefix(req.model) } as T;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wrapped = {
    ...base,
    createResponse: (req: any) => base.createResponse(transformRequest(req)),
    ...(base.streamResponse
      ? {
          streamResponse: (req: any, signal?: AbortSignal) => {
            const nonNullStream = base.streamResponse!;
            return nonNullStream(transformRequest(req), signal);
          },
        }
      : {}),
    listModels: async () => {
      const fallback = fallbackModelsFor(providerName);
      if (!base.listModels) return fallback;
      try {
        const upstream = await base.listModels();
        if (upstream && upstream.length > 0) return upstream;
        return fallback;
      } catch {
        return fallback;
      }
    },
  } as AiProvider;
  return wrapped;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fallbackModelsFor(provider: CloudProvider): any[] {
  // Curated minimal catalogs — keep short, recent, and non-exhaustive.
  // The operator picks one to chat with; they can add custom catalog
  // entries if they need a model we don't list.
  const now = Math.floor(Date.now() / 1000);
  if (provider === 'anthropic') {
    return [
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20251022',
      'claude-haiku-4-5-20251001',
      'claude-3-7-sonnet-20250219',
      'claude-3-5-sonnet-20241022',
    ].map((id) => ({
      id,
      object: 'model' as const,
      created: now,
      owned_by: 'anthropic',
      capabilities: ['chat' as const, 'tools' as const, 'vision' as const, 'long_context' as const],
    }));
  }
  if (provider === 'gemini') {
    return [
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-2.5-flash-8b',
    ].map((id) => ({
      id,
      object: 'model' as const,
      created: now,
      owned_by: 'google',
      capabilities: ['chat' as const, 'tools' as const, 'vision' as const, 'long_context' as const],
    }));
  }
  return [];
}

/**
 * Nova's OpenAI-compat adapter assumes `baseUrl` already terminates
 * at `/v1` (or another explicit API version) and appends paths like
 * `/chat/completions`, `/embeddings`, `/models` verbatim. Operators
 * registering cloud nodes naturally type `http://host:port` or
 * `https://host` without the `/v1` — append it when absent so
 * `node add-cloud` + `llamactl rag ask` + every downstream chat /
 * embed path hit the right URL. Mirrors the same rule already
 * applied to `embedder.baseUrl` in rag/embedding.ts; lives here too
 * so cloud-node registrations go through it.
 *
 * Skip the append when the URL already ends in `/v<n>` — keeps the
 * escape hatch for operators with a proxy that exposes a different
 * versioned prefix (or none) open.
 */
function normalizeOpenAICompatBaseUrl(url: string, providerName?: CloudProvider): string {
  const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
  // Google's OpenAI-compat shim lives at /v1beta/openai/ — a path
  // that DOESN'T end in /v<n> so the default-append rule above
  // would bolt on a bogus /v1 and every request would 404. Skip
  // the append when the URL already terminates at .../openai.
  if (/\/openai$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return trimmed;
  if (providerName === 'gemini') return trimmed;
  return `${trimmed}/v1`;
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
  /** Whole config — required for provider-kind lookups that need to
   *  trace back to the parent gateway. */
  cfg?: Config;
  env?: NodeJS.ProcessEnv;
  /** Runtime-specific pinned-fetch factory for agent nodes. Omit for
   *  CLI (Bun's native fetch picks up `tls.ca` from the link layer).
   *  Electron main passes `makeNodePinnedFetch`. */
  fetchFactory?: PinnedFetchFactory;
}): AiProvider {
  const { node, user, cfg, env = process.env, fetchFactory } = opts;
  const kind = resolveNodeKind(node);

  // Provider-kind virtual nodes resolve by walking to their parent
  // gateway and using that binding. The adapter keeps the virtual
  // node's name so telemetry / observers see `llamactl-sirius.openai`
  // rather than the parent gateway name.
  if (kind === 'provider') {
    if (!node.provider) {
      throw new Error(`provider-kind node '${node.name}' is missing provider{}`);
    }
    if (!cfg) {
      throw new Error(
        `provider-kind node '${node.name}' requires opts.cfg to resolve its parent gateway`,
      );
    }
    // CLI subscription backend — the virtual node synthesizes from an
    // agent's `cli:[]` binding, NOT a gateway's cloud binding. Dispatch
    // to the subprocess adapter; the parent "gateway" in this binding
    // is actually the hosting agent.
    if (node.provider.source === 'cli') {
      return buildCliProviderForNode({ node, cfg, env });
    }
    const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
    const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
    const parent = cluster?.nodes.find((n) => n.name === node.provider!.gateway);
    if (!parent || !parent.cloud) {
      throw new Error(
        `provider-kind node '${node.name}': parent gateway '${node.provider.gateway}' not found or missing cloud{}`,
      );
    }
    const apiKey = parent.cloud.apiKeyRef
      ? resolveApiKeyRef(parent.cloud.apiKeyRef, env)
      : '';
    return createOpenAICompatProvider({
      name: node.name,
      displayName: parent.cloud.displayName ?? node.name,
      baseUrl: parent.cloud.baseUrl,
      apiKey,
    });
  }

  // Gateway + cloud-direct both carry a `cloud` binding and want
  // the same provider-quirks-wrapped openai-compat adapter. Without
  // the cloud branch here, chatStream for gemini-direct /
  // anthropic-direct / openai-direct would fall through to the
  // agent path — which treats the cloud URL as if it were a
  // llamactl agent endpoint and sends the agent's bearer instead
  // of the cloud API key. That's the "still erroring on gemini"
  // bug: transform was there, but unreachable.
  if (kind === 'gateway' || kind === 'cloud') return providerForCloudNode(node, env);

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
 * Walk from a CLI-synthesis virtual node back to its hosting
 * agent's `cli[]` binding and materialize a `CliSubprocessAdapter`.
 * The subprocess runs on the agent's own machine (where the CLI
 * is authenticated); this function just wires the binding into
 * the provider construction.
 */
function buildCliProviderForNode(opts: {
  node: ClusterNode;
  cfg: Config;
  env: NodeJS.ProcessEnv;
}): AiProvider {
  const { node, cfg, env } = opts;
  if (!node.provider) {
    throw new Error(`cli-source provider-kind node '${node.name}' missing provider{}`);
  }
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
  const agent = cluster?.nodes.find(
    (n) => n.name === node.provider!.gateway && resolveNodeKind(n) === 'agent',
  );
  if (!agent) {
    throw new Error(
      `cli-source provider-kind node '${node.name}': parent agent '${node.provider.gateway}' not found`,
    );
  }
  const binding = agent.cli?.find((b) => b.name === node.provider!.providerName);
  if (!binding) {
    throw new Error(
      `cli-source provider-kind node '${node.name}': binding '${node.provider.providerName}' not declared on agent '${agent.name}'`,
    );
  }
  // Dynamic import avoids pulling the cli/ module into consumers
  // that never touch a CLI binding. The subprocess adapter ships
  // its own Bun.spawn dependency — don't force that surface onto
  // every factory caller.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createCliSubprocessProvider } = require('../cli/adapter.js') as {
    createCliSubprocessProvider: (o: {
      agentName: string;
      binding: typeof binding;
      env?: NodeJS.ProcessEnv;
    }) => AiProvider;
  };
  return createCliSubprocessProvider({
    agentName: agent.name,
    binding,
    env,
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
