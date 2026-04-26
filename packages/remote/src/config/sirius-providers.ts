import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { CompositeOwnershipSchema } from '../workload/gateway-catalog/schema.js';

/**
 * llamactl-owned storage for sirius provider configs. Users set up
 * OpenAI/Anthropic/Together/etc. keys via `llamactl sirius
 * add-provider` (or the UI); sirius reads this file at boot to
 * register the providers on its side. llamactl is the friendly front
 * end; sirius is the runtime.
 *
 * File format (YAML):
 *
 *     apiVersion: llamactl/v1
 *     kind: SiriusProviderList
 *     providers:
 *       - name: openai
 *         kind: openai
 *         apiKeyRef: $OPENAI_API_KEY
 *       - name: anthropic
 *         kind: anthropic
 *         apiKeyRef: ~/.llamactl/keys/anthropic
 *       - name: custom-llama
 *         kind: openai-compatible
 *         baseUrl: http://gpu-host.lan:8000/v1
 *         apiKeyRef: $CUSTOM_KEY        # optional
 */

export const SiriusProviderKindSchema = z.enum([
  'openai',
  'anthropic',
  'together',
  'groq',
  'mistral',
  'openai-compatible',
]);
export type SiriusProviderKind = z.infer<typeof SiriusProviderKindSchema>;

export const SiriusProviderSchema = z.object({
  /** Stable id used by sirius as the provider name. */
  name: z.string().min(1),
  kind: SiriusProviderKindSchema,
  /** Env var (`$VAR`) or file path. Optional for
   *  `openai-compatible` when the upstream is anonymous. */
  apiKeyRef: z.string().optional(),
  /** Required for `openai-compatible`; defaulted from the kind for
   *  the named providers (openai, anthropic, …). */
  baseUrl: z.url().optional(),
  displayName: z.string().optional(),
  ownership: CompositeOwnershipSchema.optional(),
});
export type SiriusProvider = z.infer<typeof SiriusProviderSchema>;

const SiriusProviderFileSchema = z.object({
  apiVersion: z.literal('llamactl/v1').default('llamactl/v1'),
  kind: z.literal('SiriusProviderList').default('SiriusProviderList'),
  providers: z.array(SiriusProviderSchema).default([]),
});
type SiriusProviderFile = z.infer<typeof SiriusProviderFileSchema>;

export function defaultSiriusProvidersPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_SIRIUS_PROVIDERS?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'sirius-providers.yaml');
}

export function loadSiriusProviders(
  path: string = defaultSiriusProvidersPath(),
): SiriusProvider[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const parsed = SiriusProviderFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.providers;
}

export function saveSiriusProviders(
  providers: readonly SiriusProvider[],
  path: string = defaultSiriusProvidersPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: SiriusProviderFile = {
    apiVersion: 'llamactl/v1',
    kind: 'SiriusProviderList',
    providers: providers.map((p) => SiriusProviderSchema.parse(p)),
  };
  writeFileSync(path, stringifyYaml(file), 'utf8');
}

export function upsertSiriusProvider(
  providers: readonly SiriusProvider[],
  entry: SiriusProvider,
): SiriusProvider[] {
  const filtered = providers.filter((p) => p.name !== entry.name);
  return [...filtered, entry];
}

export function removeSiriusProvider(
  providers: readonly SiriusProvider[],
  name: string,
): SiriusProvider[] {
  return providers.filter((p) => p.name !== name);
}

/** Default OpenAI-compat base URLs for the named provider kinds. */
export const SIRIUS_PROVIDER_DEFAULT_BASE_URLS: Record<SiriusProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  mistral: 'https://api.mistral.ai/v1',
  'openai-compatible': '',
};
