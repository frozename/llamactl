import { z } from 'zod';

export const GpuFactsSchema = z.object({
  kind: z.enum(['metal', 'cuda', 'rocm', 'cpu']),
  name: z.string().optional(),
  memoryMB: z.number().optional(),
});

export const NodeFactsSchema = z.object({
  profile: z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']),
  memBytes: z.number().nullable(),
  os: z.string(),
  arch: z.string(),
  platform: z.string(),
  llamaCppBuildId: z.string().nullable(),
  gpu: GpuFactsSchema.nullable(),
  versions: z.object({
    llamactl: z.string(),
    bun: z.string(),
    llamaCppSrcRev: z.string().nullable(),
  }),
  startedAt: z.string(),
});

/**
 * Cloud-provider binding. When a node carries this block, its
 * `kind` is `'cloud'` and llamactl treats it as an external AI
 * endpoint (OpenAI, Anthropic, Together, groq, …) rather than a
 * self-hosted agent. `apiKeyRef` is either an absolute path to a
 * file containing the key or an `$ENV_VAR_NAME` reference; the
 * control plane resolves it at call time so the renderer never sees
 * raw keys.
 */
export const CloudProviderSchema = z.enum([
  'openai',
  'anthropic',
  'together',
  'groq',
  'mistral',
  'openai-compatible',
  'sirius',
]);
export type CloudProvider = z.infer<typeof CloudProviderSchema>;

export const CloudBindingSchema = z.object({
  provider: CloudProviderSchema,
  baseUrl: z.url(),
  /**
   * API key reference. Required for most providers; optional for
   * `sirius` and `openai-compatible` (a locally-run sirius-gateway
   * or a dev llama-server often runs anonymously on loopback).
   * When absent, the provider adapter omits the Authorization header.
   */
  apiKeyRef: z.string().optional(),
  /** Optional display name for UIs when the user wants a friendlier
   *  label than the node's canonical id. */
  displayName: z.string().optional(),
});
export type CloudBinding = z.infer<typeof CloudBindingSchema>;

/**
 * Node taxonomy:
 *
 *   * `agent`    — self-hosted llama.cpp behind an llamactl-native
 *     agent (HTTPS + bearer + pinned TLS).
 *   * `gateway`  — any external OpenAI-compatible URL: sirius,
 *     OpenRouter, LiteLLM, a peer llamactl's `/v1`. Runtime is
 *     identical across all of them (nova.createOpenAICompatProvider).
 *   * `provider` — *synthesized*, not persisted. For every gateway
 *     node, llamactl projects one provider-kind virtual node per
 *     entry in `sirius-providers.yaml`. Name shape
 *     `<gateway>.<provider>` (e.g., `sirius.openai`). Chat traffic
 *     for a provider node hits its parent gateway; the model picker
 *     is scoped to models that gateway's `/v1/models` reports as
 *     `owned_by === providerName`. First-class targets for every
 *     feature (bench, workload, chat, logs) — no per-feature
 *     special cases.
 */
export const NodeKindSchema = z.enum(['agent', 'gateway', 'provider']);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/**
 * Pointer from a provider-kind virtual node to its parent gateway
 * + the name it carries within that gateway's upstream catalog. Only
 * set on synthesized nodes (never persisted to disk); `nodeList`
 * derives these from `sirius-providers.yaml` at read time.
 */
export const ProviderBindingSchema = z.object({
  gateway: z.string().min(1),
  providerName: z.string().min(1),
});
export type ProviderBinding = z.infer<typeof ProviderBindingSchema>;

export const ClusterNodeSchema = z.object({
  name: z.string().min(1),
  /** Agent endpoint — `https://host:port` for a remote agent or the
   *  `inproc://local` sentinel. Ignored (may be empty or absent on
   *  disk) for gateway and provider nodes. */
  endpoint: z.string().default(''),
  kind: NodeKindSchema.optional(),
  certificateFingerprint: z.string().optional(),
  certificate: z.string().optional(),
  facts: NodeFactsSchema.partial().optional(),
  cloud: CloudBindingSchema.optional(),
  /** Provider-kind only — pointer into a gateway's upstream catalog. */
  provider: ProviderBindingSchema.optional(),
}).refine(
  (n) => {
    // Legacy kubeconfigs may carry `kind: 'cloud'`. Treat that as
    // gateway for validation — the data shape is identical.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawKind = (n as any).kind as string | undefined;
    const k =
      rawKind === 'gateway' || rawKind === 'agent' || rawKind === 'provider'
        ? rawKind
        : rawKind === 'cloud'
          ? 'gateway'
          : n.provider
            ? 'provider'
            : n.cloud
              ? 'gateway'
              : 'agent';
    if (k === 'provider') return !!n.provider;
    if (k === 'gateway') return !!n.cloud;
    return typeof n.endpoint === 'string' && n.endpoint.length > 0;
  },
  {
    message:
      "agent nodes require endpoint; gateway nodes require cloud{} block; provider nodes require provider{} block",
  },
);

export const ClusterSchema = z.object({
  name: z.string().min(1),
  nodes: z.array(ClusterNodeSchema).default([]),
});

export const ContextSchema = z.object({
  name: z.string().min(1),
  cluster: z.string().min(1),
  user: z.string().min(1),
  defaultNode: z.string().min(1).default('local'),
});

export const UserSchema = z.object({
  name: z.string().min(1),
  tokenRef: z.string().min(1).optional(),
  token: z.string().min(1).optional(),
}).refine((u) => u.tokenRef !== undefined || u.token !== undefined, {
  message: 'user must have either tokenRef or token',
});

export const ConfigSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('Config'),
  currentContext: z.string().min(1),
  contexts: z.array(ContextSchema).default([]),
  clusters: z.array(ClusterSchema).default([]),
  users: z.array(UserSchema).default([]),
});

export type GpuFacts = z.infer<typeof GpuFactsSchema>;
export type NodeFacts = z.infer<typeof NodeFactsSchema>;
export type ClusterNode = z.infer<typeof ClusterNodeSchema>;
export type Cluster = z.infer<typeof ClusterSchema>;
export type Context = z.infer<typeof ContextSchema>;
export type User = z.infer<typeof UserSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export const LOCAL_NODE_NAME = 'local';
export const LOCAL_NODE_ENDPOINT = 'inproc://local';

/**
 * Derive the effective kind of a node.
 *
 *   * Explicit `kind` wins. Legacy `'cloud'` values auto-upgrade to
 *     `'gateway'` on read so older kubeconfigs keep working after
 *     the cloud→gateway collapse.
 *   * Any node carrying a `cloud` binding is a gateway — that block
 *     carries the OpenAI-compat URL regardless of upstream variety.
 *   * Otherwise it's an agent.
 */
export function resolveNodeKind(node: ClusterNode): NodeKind {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const explicit = (node as any).kind as string | undefined;
  if (explicit === 'gateway' || explicit === 'agent' || explicit === 'provider') return explicit;
  if (explicit === 'cloud') return 'gateway';
  if (node.provider) return 'provider';
  return node.cloud ? 'gateway' : 'agent';
}

/** Default OpenAI-compatible base URLs for each built-in provider.
 *  UIs pre-fill these so users only need to paste the API key. */
export const DEFAULT_CLOUD_BASE_URLS: Record<CloudProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  'openai-compatible': '',
  // sirius-gateway typically runs on localhost for the single-user
  // case; production deployments will point at a real host. The
  // OpenAI-compat adapter treats this identically to `openai-compatible`,
  // we keep the provider name distinct so the UI can render a
  // gateway badge and the user understands what they're pointing at.
  sirius: 'http://localhost:3000/v1',
};

export function freshConfig(): Config {
  return {
    apiVersion: 'llamactl/v1',
    kind: 'Config',
    currentContext: 'default',
    contexts: [
      { name: 'default', cluster: 'home', user: 'me', defaultNode: LOCAL_NODE_NAME },
    ],
    clusters: [
      { name: 'home', nodes: [{ name: LOCAL_NODE_NAME, endpoint: LOCAL_NODE_ENDPOINT }] },
    ],
    users: [{ name: 'me', token: 'inproc-local' }],
  };
}
