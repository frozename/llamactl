// packages/remote/src/workload/gateway-catalog/sirius-entries.ts
import type { CompositeGatewayContext } from '../gateway-handlers/types.js';

export interface DerivedSiriusEntry {
  name: string;
  kind: 'openai-compatible';
  baseUrl: string;
  apiKeyRef?: string;
  displayName?: string;
}

export function deriveSiriusEntries(
  ctx: CompositeGatewayContext,
): DerivedSiriusEntry[] {
  return ctx.upstreams.map((u) => ({
    name: `${ctx.compositeName}-${u.name}`,
    kind: 'openai-compatible' as const,
    baseUrl: u.endpoint,
    displayName: ctx.providerConfig.displayName,
  }));
}
