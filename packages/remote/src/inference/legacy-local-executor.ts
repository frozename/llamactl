import type { inferenceContracts, routingCatalog } from "@llamactl/core";
import type { ResolvedEnv } from "@llamactl/core/types";

/**
 * Legacy local executor — the unified-proxy BackendExecutor that
 * delegates to the existing core forwarding path (`openaiProxy.proxyOpenAI`)
 * with no behavior change. Cancellation composes an executor-side abort
 * with the client request's own signal, which proxyOpenAI already
 * propagates to the upstream fetch.
 */
import { openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";

import type { BackendExecutionContext, BackendExecutor } from "../proxy/create-proxy.js";

function composeSignals(signals: readonly AbortSignal[]): AbortSignal | undefined {
  const live = signals.filter((s) => !s.aborted);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn.call(AbortSignal, live);
  const controller = new AbortController();
  for (const source of live) {
    source.addEventListener(
      "abort",
      () => {
        controller.abort(source.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

export function createLegacyLocalExecutor(
  opts: {
    resolved?: ResolvedEnv | (() => ResolvedEnv);
    proxy?: (req: Request, resolved: ResolvedEnv) => Promise<Response>;
  } = {},
): BackendExecutor {
  const inFlight = new Map<string, AbortController>();
  const resolvedOpt = opts.resolved;
  const resolve: () => ResolvedEnv =
    typeof resolvedOpt === "function"
      ? resolvedOpt
      : (): ResolvedEnv => resolvedOpt ?? resolveEnv();
  const proxy =
    opts.proxy ??
    ((req: Request, res: ResolvedEnv): Promise<Response> => openaiProxy.proxyOpenAI(req, res));

  const abortAll = (): void => {
    for (const controller of inFlight.values()) controller.abort();
  };

  return {
    describe: (): {
      id: string;
      backendKinds: routingCatalog.BackendKind[];
      transports: routingCatalog.RouteTransport[];
    } => ({
      id: "legacy-local-executor",
      backendKinds: ["local-model"],
      transports: ["local-http", "worker-rpc"],
    }),
    execute: async (
      envelope: inferenceContracts.InferenceEnvelopeV1,
      ctx: BackendExecutionContext,
    ): Promise<Response> => {
      const controller = new AbortController();
      inFlight.set(envelope.attemptId, controller);
      try {
        const signal = composeSignals(
          [ctx.req.signal, controller.signal].concat(ctx.signal ? [ctx.signal] : []),
        );
        const forwarded = new Request(ctx.req, { signal: signal ?? ctx.req.signal });
        return await proxy(forwarded, resolve());
      } finally {
        inFlight.delete(envelope.attemptId);
      }
    },
    cancel: (attemptId: string): boolean => {
      const controller = inFlight.get(attemptId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
    drain: (): Promise<void> => {
      abortAll();
      return Promise.resolve();
    },
    close: (): Promise<void> => {
      abortAll();
      inFlight.clear();
      return Promise.resolve();
    },
  };
}
