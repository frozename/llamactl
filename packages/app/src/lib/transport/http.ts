// Web-console HTTP transport (#410 P1). Cookie-credentialed batch + SSE
// links against `{baseUrl}/trpc`; no Authorization header, no transformer
// (plan §0.4). fetch/EventSource are injectable so tests own the network.
// The batch-fetch adapter is cast through the link's own fetch parameter
// type the same way buildPinnedLinks does in @llamactl/remote — Bun's and
// the DOM's fetch/ReadableStream generics differ from tRPC's *Esque types.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";

type HttpBatchFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>;

export interface BuildHttpLinksOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  EventSource?: typeof globalThis.EventSource;
}

export function buildHttpLinks<TRouter extends AnyRouter>(
  opts: BuildHttpLinksOptions,
): TRPCLink<TRouter>[] {
  const credentialedFetch = (url: string, init?: RequestInit): Promise<Response> =>
    (opts.fetch ?? globalThis.fetch)(url, { ...init, credentials: "include" });
  const links = splitLink({
    condition: (op) => op.type === "subscription",
    true: httpSubscriptionLink({
      url: `${opts.baseUrl}/trpc`,
      ...(opts.EventSource ? { EventSource: opts.EventSource } : {}),
      eventSourceOptions: { withCredentials: true },
    }),
    false: httpBatchLink({
      url: `${opts.baseUrl}/trpc`,
      fetch: credentialedFetch as unknown as HttpBatchFetch,
    }),
  });
  return [links];
}
