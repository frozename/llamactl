// Builds the per-node client pair for the web console (#410 P3). One
// QueryClient + tRPC client per tab node, with the node baked into every
// request URL by buildHttpLinks; there is no module-global node. Lives in
// its own module so node-scoped-provider.tsx exports components only.

import type { AppRouter } from "@llamactl/remote";

import { QueryClient } from "@tanstack/react-query";

import { buildHttpLinks } from "../lib/transport/http";
import { createAppClient } from "../lib/trpc";

export interface CreateNodeScopeOptions {
  node: string;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  EventSource?: unknown;
}

export interface NodeScope {
  queryClient: QueryClient;
  client: ReturnType<typeof createAppClient>;
}

export function createNodeScope(opts: CreateNodeScopeOptions): NodeScope {
  return {
    queryClient: new QueryClient({
      defaultOptions: {
        queries: {
          staleTime: 30_000,
          refetchOnWindowFocus: false,
        },
      },
    }),
    client: createAppClient(
      buildHttpLinks<AppRouter>({
        baseUrl: opts.baseUrl,
        node: opts.node,
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        ...(opts.EventSource
          ? { EventSource: opts.EventSource as typeof globalThis.EventSource }
          : {}),
      }),
    ),
  };
}
