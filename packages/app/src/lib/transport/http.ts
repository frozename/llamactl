// Web-console HTTP transport (#410 P1, #410 P3: the node path segment,
// the per-tab node, never a module global). Cookie-credentialed batch +
// SSE links against `{baseUrl}/n/{node}/trpc`, matching the server's
// /api/n/:node/trpc mount; no Authorization header, no transformer
// (plan §0.4). fetch/EventSource are injectable so tests own the network.
// The batch-fetch adapter is cast through the link's own fetch parameter
// type the same way buildPinnedLinks does in @llamactl/remote — Bun's and
// the DOM's fetch/ReadableStream generics differ from tRPC's *Esque types.
// CONSOLE_NODE_NAME is a literal copy of CONSOLE_NODE_SEGMENT in
// @llamactl/remote's console/node-route.ts and must stay a copy: the web
// graph stays server-free. packages/app/test/console/node-scope.test.ts
// guards against drift.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";

type HttpBatchFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>;

export const CONSOLE_NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

export function isConsoleNodeName(name: string): boolean {
  return CONSOLE_NODE_NAME.test(name);
}

export interface BuildHttpLinksOptions {
  baseUrl: string;
  node: string;
  fetch?: typeof globalThis.fetch;
  EventSource?: typeof globalThis.EventSource;
}

export function buildHttpLinks<TRouter extends AnyRouter>(
  opts: BuildHttpLinksOptions,
): TRPCLink<TRouter>[] {
  if (!isConsoleNodeName(opts.node)) {
    throw new Error(`invalid console node: ${JSON.stringify(opts.node)}`);
  }
  const url = `${opts.baseUrl}/n/${encodeURIComponent(opts.node)}/trpc`;
  const credentialedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    (opts.fetch ?? globalThis.fetch)(url, { ...init, credentials: "include" });
  const links = splitLink({
    condition: (op) => op.type === "subscription",
    true: httpSubscriptionLink({
      url,
      ...(opts.EventSource ? { EventSource: opts.EventSource } : {}),
      eventSourceOptions: { withCredentials: true },
    }),
    false: httpBatchLink({
      url,
      fetch: credentialedFetch as unknown as HttpBatchFetch,
    }),
  });
  return [links];
}
