// packages/remote/src/workload/gateway-catalog/embersynth-entries.ts
import type { CompositeGatewayContext } from '../gateway-handlers/types.js';
import type { EmbersynthNode } from '../../config/embersynth.js';

export type DerivedEmbersynthEntry = EmbersynthNode;

export function deriveEmbersynthEntries(
  ctx: CompositeGatewayContext,
): DerivedEmbersynthEntry[] {
  const tags = ctx.providerConfig.tags ?? [];
  const priority = ctx.providerConfig.priority ?? 10;
  return ctx.upstreams.map((u) => ({
    id: `${ctx.compositeName}-${u.name}`,
    label: ctx.providerConfig.displayName ?? `${ctx.compositeName}/${u.name}`,
    endpoint: u.endpoint,
    transport: 'http' as const,
    enabled: true,
    capabilities: [],
    tags,
    providerType: 'openai-compatible' as const,
    modelId: 'default',
    priority,
  }));
}
