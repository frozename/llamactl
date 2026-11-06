// Web-console HTTP transport (#410 P1, #410 P3: the node path segment,
// the per-tab node, never a module global; #410 P4: the subscription leg
// gains the reconnect lifecycle + invalid-session classification, and the
// batch leg gains the invalid-session observer). Cookie-credentialed
// batch + SSE links against `{baseUrl}/n/{node}/trpc`, matching the
// server's /api/n/:node/trpc mount; no Authorization header, no
// transformer (plan §0.4). fetch/EventSource are injectable so tests own
// the network. The batch-fetch adapter is cast through the link's own
// fetch parameter type the same way buildPinnedLinks does in
// @llamactl/remote — Bun's and the DOM's fetch/ReadableStream generics
// differ from tRPC's *Esque types. CONSOLE_NODE_NAME is a literal copy of
// CONSOLE_NODE_SEGMENT in @llamactl/remote's console/node-route.ts and
// must stay a copy: the web graph stays server-free.
// packages/app/test/console/node-scope.test.ts guards against drift.

import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";

import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";

import type { LifecycleTimers, SseLifecycleStateChange } from "./sse-lifecycle";

import { consoleSessionStore } from "../../console/session-store";
import { classifyTransportError } from "./errors";
import { ConsoleEventSource, sseLifecycleLink } from "./sse-lifecycle";

type HttpBatchFetch = NonNullable<Parameters<typeof httpBatchLink>[0]["fetch"]>;

export const CONSOLE_NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;

// Literal copy of CONSOLE_MAX_BATCH_SEGMENTS in @llamactl/remote's
// console/guards.ts and must stay a copy: the web graph stays server-free,
// same as CONSOLE_NODE_NAME.
// packages/app/test/lib/transport/http-links.test.ts guards against drift.
export const CONSOLE_MAX_BATCH_ITEMS = 16;

export function isConsoleNodeName(name: string): boolean {
  return CONSOLE_NODE_NAME.test(name);
}

export interface BuildHttpLinksOptions {
  baseUrl: string;
  node: string;
  fetch?: typeof globalThis.fetch;
  EventSource?: typeof globalThis.EventSource;
  timers?: LifecycleTimers;
  onInvalidSession?: () => void;
  onStateChange?: (event: SseLifecycleStateChange) => void;
}

export function buildHttpLinks<TRouter extends AnyRouter>(
  opts: BuildHttpLinksOptions,
): TRPCLink<TRouter>[] {
  if (!isConsoleNodeName(opts.node)) {
    throw new Error(`invalid console node: ${JSON.stringify(opts.node)}`);
  }
  const url = `${opts.baseUrl}/n/${encodeURIComponent(opts.node)}/trpc`;
  const credentialedFetch = (url: string | URL, init?: RequestInit): Promise<Response> =>
    (opts.fetch ?? globalThis.fetch)(url, { ...init, credentials: "include" });
  const markInvalid = opts.onInvalidSession ?? consoleSessionStore.markInvalid;
  const invalidSessionObserverLink: TRPCLink<AnyRouter> = () => {
    return ({ op, next }) => {
      return observable((observer) => {
        return next(op).subscribe({
          next(envelope) {
            observer.next(envelope);
          },
          error(err) {
            if (classifyTransportError(err).kind === "invalid_session") {
              markInvalid();
            }
            observer.error(err);
          },
          complete() {
            observer.complete();
          },
        });
      });
    };
  };
  // The link factories are instantiated at AnyRouter so tRPC's
  // TransformerOptions conditional resolves concretely — against the
  // deferred generic TRouter it demands a `transformer` key this link
  // set intentionally never sends.
  const links = splitLink({
    condition: (op) => op.type === "subscription",
    true: [
      sseLifecycleLink<AnyRouter>({
        ...(opts.timers ? { timers: opts.timers } : {}),
        ...(opts.onInvalidSession ? { onInvalidSession: opts.onInvalidSession } : {}),
        ...(opts.onStateChange ? { onStateChange: opts.onStateChange } : {}),
      }),
      httpSubscriptionLink<AnyRouter, typeof ConsoleEventSource>({
        url,
        EventSource: (opts.EventSource ??
          ConsoleEventSource) as unknown as typeof ConsoleEventSource,
        eventSourceOptions: {
          withCredentials: true,
          ...(opts.EventSource ? {} : { fetch: credentialedFetch }),
        },
      }),
    ],
    false: [
      invalidSessionObserverLink,
      httpBatchLink<AnyRouter>({
        url,
        maxItems: CONSOLE_MAX_BATCH_ITEMS,
        fetch: credentialedFetch as unknown as HttpBatchFetch,
      }),
    ],
  });
  return [links];
}
