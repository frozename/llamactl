import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { loadConfig, resolveToken } from './kubeconfig.js';
import {
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
  type ClusterNode,
  type Config,
} from './schema.js';
import { loadSiriusProviders } from './sirius-providers.js';

/**
 * llamactl-owned `embersynth.yaml` generator. Embersynth orchestrates
 * AI nodes via capability-based routing; llamactl is the source of
 * truth for WHICH nodes exist (agents + sirius providers) and for the
 * routing profiles the user wants embersynth to expose as synthetic
 * models. Single YAML file, one writer, shared schema.
 *
 * Round-trip:
 *   llamactl nodes → embersynth.yaml `nodes:`
 *   user-edited profiles → embersynth.yaml `profiles:`
 *   each profile's synthetic model (`fusion-<id>`) → embersynth.yaml
 *     `syntheticModels:` → back into llamactl as a provider-kind
 *     synth node (`<gateway>.fusion-<id>`)
 *
 * Scope today is a generator + loader. embersynth itself already
 * reads this shape (see `config/embersynth.example.yaml` in the
 * embersynth repo) — no embersynth-side changes needed for Phase 1.
 */

// ---- Schema (tight subset of embersynth's full config) --------------

const EmbersynthAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('bearer'),
    token: z.string(),
  }),
]);

const EmbersynthNodeSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  endpoint: z.string(),
  transport: z.literal('http').default('http'),
  enabled: z.boolean().default(true),
  capabilities: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  providerType: z.literal('openai-compatible').default('openai-compatible'),
  modelId: z.string().default('default'),
  priority: z.number().int().default(10),
  auth: EmbersynthAuthSchema.optional(),
  health: z
    .object({
      endpoint: z.string().optional(),
      intervalMs: z.number().int().optional(),
      timeoutMs: z.number().int().optional(),
    })
    .optional(),
  timeout: z
    .object({
      requestMs: z.number().int().optional(),
      connectMs: z.number().int().optional(),
    })
    .optional(),
});

const EmbersynthProfileSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  description: z.string().optional(),
  preferLowerPriority: z.boolean().optional(),
  allowDegradedNodes: z.boolean().optional(),
  maxStages: z.number().int().optional(),
  preferredCapabilities: z.array(z.string()).optional(),
  requiredTags: z.array(z.string()).optional(),
  synthesisRequired: z.boolean().optional(),
});

export const EmbersynthConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(7777),
    })
    .default({ host: '127.0.0.1', port: 7777 }),
  nodes: z.array(EmbersynthNodeSchema).default([]),
  profiles: z.array(EmbersynthProfileSchema).default([]),
  syntheticModels: z.record(z.string(), z.string()).default({}),
  policy: z
    .object({
      fallbackEnabled: z.boolean().default(true),
      maxRetries: z.number().int().default(2),
      retryDelayMs: z.number().int().default(500),
      requireHealthy: z.boolean().default(true),
    })
    .optional(),
});
export type EmbersynthConfig = z.infer<typeof EmbersynthConfigSchema>;
export type EmbersynthNode = z.infer<typeof EmbersynthNodeSchema>;
export type EmbersynthProfile = z.infer<typeof EmbersynthProfileSchema>;

// ---- Storage ---------------------------------------------------------

export function defaultEmbersynthConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_EMBERSYNTH_CONFIG?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'embersynth.yaml');
}

export function loadEmbersynthConfig(
  path: string = defaultEmbersynthConfigPath(),
): EmbersynthConfig | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8');
  return EmbersynthConfigSchema.parse(parseYaml(raw) ?? {});
}

export function saveEmbersynthConfig(
  cfg: EmbersynthConfig,
  path: string = defaultEmbersynthConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(EmbersynthConfigSchema.parse(cfg)), 'utf8');
}

// ---- Generation from llamactl state ----------------------------------

/**
 * Best-effort capability guesses for each provider kind. Users can
 * edit `embersynth.yaml` afterwards to tune — this just avoids
 * starting from an empty list. llamactl agents are tagged as
 * `reasoning` since they typically run a chat-completion llama.cpp
 * build; users can add `vision` when they pull a vision model.
 */
const DEFAULT_CAPABILITIES_BY_PROVIDER: Record<string, string[]> = {
  openai: ['reasoning', 'tools', 'json_mode'],
  anthropic: ['reasoning', 'long_context', 'tools'],
  together: ['reasoning'],
  groq: ['reasoning'],
  mistral: ['reasoning'],
  'openai-compatible': ['reasoning'],
};

function agentToEmbersynthNode(
  node: ClusterNode,
  token: string,
): EmbersynthNode {
  const endpoint = node.endpoint === LOCAL_NODE_ENDPOINT
    ? 'http://127.0.0.1:8080'
    : node.endpoint.replace(/\/$/, '');
  return EmbersynthNodeSchema.parse({
    id: `agent-${node.name}`,
    label: `llamactl agent '${node.name}'`,
    endpoint: `${endpoint}/v1`,
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['llamactl', 'agent', 'local', 'private'],
    providerType: 'openai-compatible',
    modelId: 'default',
    priority: 1,
    auth: { type: 'bearer', token },
    health: { endpoint: '/healthz', intervalMs: 30000 },
  });
}

function siriusProviderToEmbersynthNode(
  providerName: string,
  providerKind: string,
  baseUrl: string,
  apiKeyRef?: string,
): EmbersynthNode {
  const capabilities = DEFAULT_CAPABILITIES_BY_PROVIDER[providerKind] ?? ['reasoning'];
  return EmbersynthNodeSchema.parse({
    id: `provider-${providerName}`,
    label: `${providerKind} (via sirius)`,
    endpoint: baseUrl.replace(/\/$/, ''),
    transport: 'http',
    enabled: true,
    capabilities,
    tags: ['cloud', providerKind],
    providerType: 'openai-compatible',
    modelId: 'default',
    priority: 10,
    auth: apiKeyRef
      ? { type: 'bearer', token: apiKeyRef }
      : { type: 'none' },
  });
}

export const DEFAULT_EMBERSYNTH_PROFILES: EmbersynthProfile[] = [
  {
    id: 'auto',
    label: 'Automatic',
    description: 'Balanced routing with automatic capability selection',
    preferLowerPriority: true,
    allowDegradedNodes: false,
  },
  {
    id: 'fast',
    label: 'Fast',
    description: 'Prefer lowest latency, minimize pipeline stages',
    maxStages: 1,
    preferLowerPriority: true,
  },
  {
    id: 'private',
    label: 'Private',
    description: 'Only use nodes tagged private',
    requiredTags: ['private'],
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Vision-capable pipeline with synthesis',
    preferredCapabilities: ['vision'],
    synthesisRequired: true,
  },
];

/**
 * Project llamactl state (kubeconfig + sirius-providers.yaml) into an
 * embersynth config. `opts.preserveProfiles` keeps the user's
 * hand-edited `profiles:` and `syntheticModels:` when regenerating
 * (used by `llamactl embersynth sync`); `opts.existing` feeds the
 * current file back in.
 */
export function generateEmbersynthConfig(opts?: {
  cfg?: Config;
  existing?: EmbersynthConfig | null;
  env?: NodeJS.ProcessEnv;
}): EmbersynthConfig {
  const cfg = opts?.cfg ?? loadConfig();
  const env = opts?.env ?? process.env;
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  const cluster = cfg.clusters.find((c) => c.name === ctx?.cluster);
  const user = cfg.users.find((u) => u.name === ctx?.user);

  const nodes: EmbersynthNode[] = [];

  // Agents
  for (const n of cluster?.nodes ?? []) {
    if (resolveNodeKind(n) !== 'agent') continue;
    if (n.endpoint === LOCAL_NODE_ENDPOINT) {
      // Skip the inproc sentinel — embersynth needs an HTTP endpoint.
      continue;
    }
    if (!user) continue;
    let token: string;
    try {
      token = resolveToken(user, env);
    } catch {
      continue;
    }
    nodes.push(agentToEmbersynthNode(n, token));
  }

  // Sirius-provider entries
  const providers = (() => {
    try {
      return loadSiriusProviders();
    } catch {
      return [];
    }
  })();
  for (const p of providers) {
    const baseUrl = p.baseUrl ?? '';
    if (!baseUrl) continue;
    nodes.push(
      siriusProviderToEmbersynthNode(p.name, p.kind, baseUrl, p.apiKeyRef),
    );
  }

  const profiles = opts?.existing?.profiles?.length
    ? opts.existing.profiles
    : DEFAULT_EMBERSYNTH_PROFILES;

  const syntheticModels =
    opts?.existing?.syntheticModels &&
    Object.keys(opts.existing.syntheticModels).length > 0
      ? opts.existing.syntheticModels
      : Object.fromEntries(profiles.map((p) => [`fusion-${p.id}`, p.id]));

  return EmbersynthConfigSchema.parse({
    server: opts?.existing?.server ?? { host: '127.0.0.1', port: 7777 },
    nodes,
    profiles,
    syntheticModels,
    policy: opts?.existing?.policy ?? {
      fallbackEnabled: true,
      maxRetries: 2,
      retryDelayMs: 500,
      requireHealthy: true,
    },
  });
}

/**
 * List synthetic model ids from an embersynth config. Callers use
 * this to project one provider-kind node per synthetic model
 * (`<gateway>.<modelId>`) during llamactl's fanout.
 */
export function listSyntheticModelIds(cfg: EmbersynthConfig): string[] {
  return Object.keys(cfg.syntheticModels);
}
