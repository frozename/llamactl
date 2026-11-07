// The local-vs-pinned-remote dispatch layer extracted from the retired
// Electron dispatcher (#410 P2a). Host-agnostic: the Bun-served console
// wraps buildDispatchRouter with error-mode resolution.
import type {
  AnyProcedure,
  BuiltRouter,
  CreateRouterOptions,
  DefaultErrorShape,
} from "@trpc/server/unstable-core-do-not-import";

import * as kubecfg from "@llamactl/core/config/kubeconfig";
import {
  type ClusterNode,
  LOCAL_NODE_ENDPOINT,
  resolveNodeKind,
} from "@llamactl/core/config/schema";
import { createTRPCClient } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";

import { buildPinnedLinks, type PinnedFetchFactory } from "../client/links.js";
import { type AppRouter, router as baseRouter } from "../router.js";

type LocalCaller = Record<string, (input: unknown) => unknown>;
type SubscriptionHandle = { unsubscribe: () => void };
type RemoteProcedure = {
  query: (input: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  mutate: (input: unknown, opts?: { signal?: AbortSignal }) => Promise<unknown>;
  subscribe: (
    input: unknown,
    handlers: {
      onData: (ev: unknown) => void;
      onError: (err: unknown) => void;
      onComplete: () => void;
    },
  ) => SubscriptionHandle;
};
type RemoteClient = Record<string, RemoteProcedure>;

type ProcedureKind = "query" | "mutation" | "subscription";
type CompatProcedureDef = AnyProcedure["_def"] & {
  query?: boolean;
  mutation?: boolean;
  subscription?: boolean;
};

/**
 * Procedures that MUST always run on the control plane, even when a
 * remote node is selected. These manage kubeconfig state (the list of
 * nodes, the current default) and workload orchestration — both only
 * make sense from the control plane's perspective.
 */
export const CONTROL_PLANE_ONLY: ReadonlySet<string> = new Set<string>([
  "nodeList",
  "nodeAdd",
  "nodeRemove",
  "nodeTest",
  "nodeSetDefault",
  "nodeOpenAIConfig",
  "nodeDiscover",
  "nodeAddCloud",
  // nodeModels resolves a by-name lookup against the local
  // kubeconfig + scrapes /v1/models on whatever the node's
  // endpoint resolves to. Must run on the control plane;
  // dispatching to a remote active-node makes that remote try to
  // look up the CALLER's node name in its OWN kubeconfig (which
  // doesn't have it) and error + leave the chat models dropdown
  // hanging on isLoading forever.
  "nodeModels",
  "chatComplete",
  "chatStream",
  "workloadList",
  "workloadsDir",
  "workloadDescribe",
  "workloadApply",
  "workloadDelete",
  "workloadValidate",
  "workloadTemplate",
  "reconcilerStatus",
  "reconcilerEvents",
  "reconcilerStart",
  "reconcilerStop",
  "reconcilerKick",
  "benchScheduleList",
  "benchScheduleAdd",
  "benchScheduleRemove",
  "benchScheduleToggle",
  "benchSchedulerStatus",
  "benchSchedulerStart",
  "benchSchedulerStop",
  "benchSchedulerKick",
  // Ops Chat: the audit journal, the session registry, and the
  // planner's allowlist all live on the control plane's filesystem +
  // main-process memory. Routing these to a remote would split the
  // session registry across processes (subscription on main, outcome
  // ack on remote) and leak audit entries into the wrong log.
  "operatorPlan",
  "operatorRunTool",
  "operatorChatStream",
  "operatorSubmitStepOutcome",
  "opsChatTools",
  "opsChatAuditTail",
  // Projects live in the control plane's projects.yaml — the
  // kubeconfig default + every registered route target + every
  // policy reference is control-plane state. Routing to a remote
  // agent makes it read its OWN projects.yaml (which doesn't
  // exist) and its auth layer 401s with a plain-text body that
  // the renderer's JSON parser chokes on
  // ("Unexpected token 'u', 'unauthorized' is not valid JSON").
  "projectApply",
  "projectList",
  "projectGet",
  "projectRemove",
  "projectIndex",
  "projectResolveRouting",
  "projectRoutePreview",
  "projectRoutingJournal",
  // Cost guardian's journal + snapshot are aggregated across the
  // whole fleet's usage records; the read lives on the control
  // plane's $DEV_STORAGE. Dispatching to a remote turns a 0.5s
  // local read into a hung tRPC call to an agent that doesn't
  // implement costSnapshot semantics — hence "loading forever".
  "costSnapshot",
  "costGuardianStatus",
  "costJournalTail",
  // UI-only procedures added by this module never go over the wire.
  "uiSetActiveNode",
  "uiGetActiveNode",
  // UI-only procedures added alongside the projects-form picker +
  // git-repo scan. Both touch the main-process filesystem +
  // Electron dialog; forwarding them to a remote agent would
  // either error (no electron runtime on agents) or scan the
  // wrong machine.
  "uiPickDirectory",
  "uiScanGitRepos",
]);

export type DispatchResolutionCode =
  | "kubeconfig_unreadable"
  | "no_current_context"
  | "unknown_node"
  | "node_not_dispatchable"
  | "user_missing"
  | "node_credentials_unavailable";

/**
 * Raised in "error" resolution mode when a dispatch target cannot be
 * resolved. The message names the code and the node; it never
 * contains the token.
 */
export class DispatchResolutionError extends Error {
  readonly code: DispatchResolutionCode;
  readonly nodeName: string | null;

  constructor(code: DispatchResolutionCode, nodeName: string | null) {
    super(`Dispatch target unresolvable (${code}) for node "${nodeName ?? "unknown"}"`);
    this.name = "DispatchResolutionError";
    this.code = code;
    this.nodeName = nodeName;
  }
}

export type OnUnresolvable = "local" | "error";

export interface DispatchTarget {
  kind: "local" | "remote";
  node?: {
    name: string;
    endpoint: string;
    certificate: string | null;
    certificateFingerprint: string | null;
    tlsServerName?: string;
  };
  token?: string;
}

/**
 * Resolve where a procedure call should run: the control plane
 * ("local") or a pinned remote node ("remote"). `onUnresolvable`
 * picks the failure policy — "local" fails open to the control plane
 * (the retired Electron dispatcher's mode), "error" throws
 * DispatchResolutionError with a machine-readable code instead.
 */
export function resolveDispatchTarget(
  path: string,
  nodeName: string | null,
  opts: { onUnresolvable: OnUnresolvable },
): DispatchTarget {
  if (CONTROL_PLANE_ONLY.has(path)) return { kind: "local" };
  const fail = (code: DispatchResolutionCode, node: string | null): DispatchTarget => {
    if (opts.onUnresolvable === "local") return { kind: "local" };
    throw new DispatchResolutionError(code, node);
  };
  let cfg;
  try {
    cfg = kubecfg.loadConfig();
  } catch {
    return fail("kubeconfig_unreadable", nodeName);
  }
  const ctx = cfg.contexts.find((c) => c.name === cfg.currentContext);
  if (!ctx) return fail("no_current_context", nodeName);
  // The caller's selected node takes precedence over kubeconfig's
  // default — so switching the UI doesn't also change what `llamactl`
  // defaults to from the CLI.
  const name = nodeName ?? ctx.defaultNode;
  const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
  const node = cluster?.nodes.find((n) => n.name === name);
  if (!node) return fail("unknown_node", name);
  if (node.endpoint === LOCAL_NODE_ENDPOINT) return { kind: "local" };
  if (opts.onUnresolvable === "error" && resolveNodeKind(node) !== "agent") {
    return fail("node_not_dispatchable", name);
  }
  const user = cfg.users.find((u) => u.name === ctx.user);
  if (!user) return fail("user_missing", name);
  let token: string;
  try {
    token = kubecfg.resolveToken(user);
  } catch {
    return fail("node_credentials_unavailable", name);
  }
  return {
    kind: "remote",
    node: {
      name: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate ?? null,
      certificateFingerprint: node.certificateFingerprint ?? null,
      ...(node.tlsServerName !== undefined ? { tlsServerName: node.tlsServerName } : {}),
    },
    token,
  };
}

/**
 * Pinned remote-client cache, keyed by the (endpoint + fingerprint +
 * token) tuple. A fresh node registration, token rotation, or cert
 * change produces a new key and a cache miss; existing keys reuse
 * the already-built `createTRPCClient` instance, avoiding the
 * linkBuilder + eventsource-ponyfill wiring cost on every query.
 */
const clientCache = new Map<string, RemoteClient>();

function cacheKey(target: DispatchTarget): string {
  if (!target.node || !target.token) return "";
  const fp = target.node.certificateFingerprint ?? "";
  // Use only the token's first 8 chars in the key — the full token is
  // already the cache invalidation signal; 8 chars is enough to
  // disambiguate independent rotations without keeping the secret in
  // an in-memory map key any longer than necessary.
  return `${target.node.endpoint}|${fp}|${target.node.tlsServerName ?? ""}|${target.token.slice(0, 8)}`;
}

export function getDispatchClient(
  target: DispatchTarget,
  fetchFactory: PinnedFetchFactory,
): RemoteClient {
  if (!target.node || !target.token) {
    throw new Error("remote target missing node or token");
  }
  const key = cacheKey(target);
  const cached = clientCache.get(key);
  if (cached) return cached;
  const node: ClusterNode = {
    name: target.node.name,
    endpoint: target.node.endpoint,
    certificate: target.node.certificate ?? undefined,
    certificateFingerprint: target.node.certificateFingerprint ?? undefined,
    tlsServerName: target.node.tlsServerName,
  };
  const client = createTRPCClient({
    links: buildPinnedLinks(node, target.token, fetchFactory),
  }) as unknown as RemoteClient;
  clientCache.set(key, client);
  return client;
}

/**
 * Test-only helper — clears the pinned-client cache so tests that
 * rotate tokens or swap cert fingerprints see fresh state.
 */
export function __resetDispatchClientCacheForTests(): void {
  clientCache.clear();
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

function localProcedure(caller: LocalCaller, path: string): (input: unknown) => unknown {
  const procedure = caller[path];
  if (!procedure) throw new Error(`Missing local tRPC procedure: ${path}`);
  return procedure;
}

function remoteProcedure(client: RemoteClient, path: string): RemoteProcedure {
  const procedure = client[path];
  if (!procedure) throw new Error(`Missing remote tRPC procedure: ${path}`);
  return procedure;
}

/**
 * Local half of `wrapSubscription`. The base subscription resolver
 * needs a real AbortSignal (`bridgeEventStream` inside the router
 * calls `signal.addEventListener('abort', ...)` unconditionally).
 * electron-trpc's v10 `callProcedure` path doesn't forward a signal
 * through `opts`, so we construct our own controller and build a
 * fresh caller bound to it. When the renderer unsubscribes, our
 * outer Observable teardown invokes `iterator.return()` on this
 * generator, which lands in the `finally` and aborts the controller
 * — letting the inner subscription's cleanup fire.
 */
async function* runLocalSubscription(
  path: string,
  input: unknown,
  clientSignal: AbortSignal | undefined,
  localCallerFactory: (signal?: AbortSignal) => LocalCaller,
): AsyncGenerator<unknown, void> {
  const controller = new AbortController();
  if (clientSignal?.aborted) controller.abort();
  const onOuterAbort = (): void => {
    controller.abort();
  };
  clientSignal?.addEventListener("abort", onOuterAbort);
  try {
    const localCaller = localCallerFactory(controller.signal);
    const iterable = (await localProcedure(localCaller, path)(input)) as AsyncIterable<unknown>;
    for await (const ev of iterable) {
      if (controller.signal.aborted) break;
      yield ev;
    }
  } finally {
    clientSignal?.removeEventListener("abort", onOuterAbort);
    controller.abort();
  }
}

/**
 * Remote half of `wrapSubscription`: bridge the tRPC client's
 * callback subscription into an async generator, honoring client
 * disconnects.
 */
async function* runRemoteSubscription(
  client: RemoteClient,
  path: string,
  input: unknown,
  clientSignal: AbortSignal | undefined,
): AsyncGenerator<unknown, void> {
  const queue: unknown[] = [];
  const state = { done: false };
  let err: unknown = null;
  let wake: (() => void) | null = null;
  const drain = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const sub = remoteProcedure(client, path).subscribe(input, {
    onData: (ev: unknown) => {
      queue.push(ev);
      drain();
    },
    onError: (e: unknown) => {
      err = e;
      state.done = true;
      drain();
    },
    onComplete: () => {
      state.done = true;
      drain();
    },
  });

  const onClientAbort = (): void => {
    try {
      sub.unsubscribe();
    } catch {
      // best effort
    }
    state.done = true;
    drain();
  };
  clientSignal?.addEventListener("abort", onClientAbort);

  try {
    for (;;) {
      if (queue.length > 0) {
        const next = queue.shift();
        yield next;
        continue;
      }
      if (state.done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (err instanceof Error) throw err;
    if (err) throw new Error(formatUnknownError(err));
  } finally {
    clientSignal?.removeEventListener("abort", onClientAbort);
    try {
      sub.unsubscribe();
    } catch {
      // best effort
    }
  }
}

interface DispatchDeps {
  fetchFactory: PinnedFetchFactory;
  nodeFromCtx: (ctx: { node?: string | null }) => string | null;
  onUnresolvable: OnUnresolvable;
  localCallerFactory: (signal?: AbortSignal) => LocalCaller;
}

function resolveTargetForCall(
  path: string,
  ctx: { node?: string | null },
  deps: DispatchDeps,
): DispatchTarget {
  try {
    return resolveDispatchTarget(path, deps.nodeFromCtx(ctx), {
      onUnresolvable: deps.onUnresolvable,
    });
  } catch (err) {
    if (err instanceof DispatchResolutionError) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: err.message,
        cause: err,
      });
    }
    throw err;
  }
}

function wrapQueryOrMutation(
  path: string,
  type: "query" | "mutation",
  deps: DispatchDeps,
): AnyProcedure {
  const resolver = (opts: { ctx: { node: string | null }; input: unknown }): unknown => {
    const target = resolveTargetForCall(path, opts.ctx, deps);
    if (target.kind === "local") {
      return localProcedure(deps.localCallerFactory(), path)(opts.input);
    }
    const client = getDispatchClient(target, deps.fetchFactory);
    const procedure = remoteProcedure(client, path);
    return type === "query" ? procedure.query(opts.input) : procedure.mutate(opts.input);
  };
  // Input shape is inferred from the underlying procedure at call
  // time; we don't re-validate here because the destination (local
  // caller or remote agent) will re-validate against its own zod
  // schema. Declaring `.input(z.unknown())` on the wrapper is
  // load-bearing though: without it, electron-trpc v1.0.0-alpha's
  // IPC serializer throws "Cannot read properties of undefined
  // (reading 'serialize')" when the renderer invokes any wrapped
  // procedure whose base version has a Zod `.input()`. Pinning
  // `z.unknown()` keeps the transformer-lookup path happy while
  // preserving our pass-through semantics.
  const base = t.procedure.input(z.unknown());
  return (type === "query" ? base.query(resolver) : base.mutation(resolver)) as AnyProcedure;
}

function wrapSubscription(path: string, deps: DispatchDeps): AnyProcedure {
  // Same rationale as `wrapQueryOrMutation` above: electron-trpc's
  // IPC serializer expects an `.input()` declaration on every wrapped
  // procedure, even when the wrapper itself does no validation.
  // Without it the input never crosses the renderer→main bridge on
  // subscriptions, and the base router's schema downstream sees
  // `undefined` → `"Invalid input: expected object, received
  // undefined"`. Pass-through semantics preserved via `z.unknown()`.
  return t.procedure.input(z.unknown()).subscription(async function* (opts) {
    const target = resolveTargetForCall(path, opts.ctx, deps);
    if (target.kind === "local") {
      yield* runLocalSubscription(path, opts.input, opts.signal, deps.localCallerFactory);
      return;
    }
    const client = getDispatchClient(target, deps.fetchFactory);
    yield* runRemoteSubscription(client, path, opts.input, opts.signal);
  }) as AnyProcedure;
}

/**
 * tRPC v11 exposes the procedure kind on `_def.type`. Older paths
 * used `_def.query`/`_def.mutation`/`_def.subscription` booleans
 * — check both to stay robust across tRPC point releases.
 */
function procedureKind(def: CompatProcedureDef): ProcedureKind | undefined {
  // Widen deliberately: at runtime `type` may be absent or carry an
  // unexpected value on other tRPC releases, despite the v11 typing.
  const rawType: string | undefined = def.type;
  if (rawType === "query" || rawType === "mutation" || rawType === "subscription") {
    return rawType;
  }
  if (def.query) return "query";
  if (def.mutation) return "mutation";
  if (def.subscription) return "subscription";
  return undefined;
}

/**
 * Default local-caller factory. Kept lazy on purpose: calling
 * `baseRouter.createCaller` at module top level would give every
 * import of `@llamactl/remote` an import-time side effect (and a TDZ
 * hazard next to the router's own module init). Semantics match the
 * hoisted caller the Electron dispatcher used, plus the per-
 * subscription signal-bound caller.
 */
let defaultCaller: LocalCaller | null = null;

function defaultLocalCallerFactory(signal?: AbortSignal): LocalCaller {
  if (signal) {
    return baseRouter.createCaller({}, { signal }) as unknown as LocalCaller;
  }
  defaultCaller ??= baseRouter.createCaller({}) as unknown as LocalCaller;
  return defaultCaller;
}

const t = initTRPC.context<{ node: string | null }>().create({
  sse: { ping: { enabled: true, intervalMs: 10_000 } },
});

export interface BuildDispatchRouterOptions {
  fetchFactory: PinnedFetchFactory;
  nodeFromCtx: (ctx: { node?: string | null }) => string | null;
  onUnresolvable: OnUnresolvable;
  localCallerFactory?: (signal?: AbortSignal) => Record<string, (input: unknown) => unknown>;
}

/**
 * The dispatch router's inferred type: AppRouter's procedure record
 * over an explicit `{ node }` context. Typed this way (rather than as
 * AppRouter) so `createCaller({ node })` typechecks for hosts like
 * P2b's console, where AppRouter's weak AgentRouterContext would
 * reject it.
 */
export type DispatchRouter = BuiltRouter<
  {
    ctx: { node: string | null };
    meta: object;
    errorShape: DefaultErrorShape;
    transformer: false;
  },
  AppRouter["_def"]["record"]
>;

/**
 * Build the dispatching router by introspecting `baseRouter._def.procedures`
 * and creating a forwarding procedure for each. Resolution happens at
 * call time via `nodeFromCtx(ctx)`, so a host's active-node state can
 * change between calls without rebuilding the router.
 *
 * `fetchFactory` lets runtimes that can't use Bun's `tls.ca` option
 * (Electron main, browser envs) inject their own pinned-fetch
 * implementation.
 */
export function buildDispatchRouter(opts: BuildDispatchRouterOptions): DispatchRouter {
  const deps: DispatchDeps = {
    fetchFactory: opts.fetchFactory,
    nodeFromCtx: opts.nodeFromCtx,
    onUnresolvable: opts.onUnresolvable,
    localCallerFactory: opts.localCallerFactory ?? defaultLocalCallerFactory,
  };
  const procs: CreateRouterOptions = {};
  const source = (
    baseRouter as unknown as { _def: { procedures: Record<string, { _def: CompatProcedureDef }> } }
  )._def.procedures;
  for (const [name, orig] of Object.entries(source)) {
    const kind = procedureKind(orig._def);
    if (kind === "subscription") {
      procs[name] = wrapSubscription(name, deps);
    } else if (kind !== undefined) {
      procs[name] = wrapQueryOrMutation(name, kind, deps);
    }
  }
  return t.router(procs) as unknown as DispatchRouter;
}
