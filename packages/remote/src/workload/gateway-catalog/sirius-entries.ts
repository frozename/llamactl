// packages/remote/src/workload/gateway-catalog/sirius-entries.ts
import type { CompositeGatewayContext } from "../gateway-handlers/types.js";

export interface DerivedSiriusEntry {
  [k: string]: unknown;
  name: string;
  kind: "openai" | "anthropic" | "together" | "groq" | "mistral" | "openai-compatible";
  baseUrl?: string | undefined;
  apiKeyRef?: string | undefined;
  displayName?: string | undefined;
}

export function deriveSiriusEntries(ctx: CompositeGatewayContext): DerivedSiriusEntry[] {
  return ctx.upstreams.map((u) => ({
    name: `${ctx.compositeName}-${u.name}`,
    kind: "openai-compatible" as const,
    baseUrl: u.endpoint,
    ...(ctx.providerConfig.displayName !== undefined
      ? { displayName: ctx.providerConfig.displayName }
      : {}),
  }));
}
