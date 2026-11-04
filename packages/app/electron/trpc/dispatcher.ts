import {
  __resetDispatchClientCacheForTests,
  type AppRouter as BaseAppRouter,
  buildDispatchRouter,
  type ClusterNode,
  type DispatchTarget,
  getDispatchClient,
  config as kubecfg,
  type PinnedFetchFactory,
} from "@llamactl/remote";
import { initTRPC, TRPCError } from "@trpc/server";
import { observable, type Observable } from "@trpc/server/observable";
import {
  type AnyProcedure,
  type AnyRouter,
  getErrorShape,
  type ProcedureCallOptions,
} from "@trpc/server/unstable-core-do-not-import";
import { z } from "zod";

import { fanOutSurface, listAgentNodes } from "./cross-node-fan-out.js";
import { makeNodePinnedFetch } from "./node-pinned-fetch.js";

/**
 * Electron main's dispatcher router. The routing logic itself (local
 * caller vs pinned-TLS remote client per procedure) lives in
 * `@llamactl/remote`'s `buildDispatchRouter`; this module is the
 * Electron adapter that keeps the module-level active-node override,
 * the UI-only sub-router, the peer-client factory and the
 * electron-trpc v10 compat shims on top of it.
 */

const t = initTRPC.create();

type KubeUser = Parameters<typeof kubecfg.resolveToken>[0];

type ProcedureKind = "query" | "mutation" | "subscription";
type CompatProcedureDef = AnyProcedure["_def"] & {
  query?: boolean;
  mutation?: boolean;
  subscription?: boolean;
};
type CompatProcedure = AnyProcedure & {
  _def: CompatProcedureDef;
  procedure?: unknown;
  meta?: unknown;
};
type RouterWithCompat = AnyRouter & {
  _def: AnyRouter["_def"] & {
    procedures: Record<string, CompatProcedure>;
  };
  getErrorShape?: (opts: {
    error: unknown;
    type: ProcedureKind | "unknown";
    path: string | undefined;
    input: unknown;
    ctx: unknown;
  }) => unknown;
};
type V10ProcedureCallOptions = {
  getRawInput?: unknown;
  rawInput?: unknown;
  [key: string]: unknown;
};

function isProcedureCallOptions(
  opts: ProcedureCallOptions<unknown> | V10ProcedureCallOptions,
): opts is ProcedureCallOptions<unknown> {
  return typeof opts.getRawInput === "function";
}

/**
 * Adapt a tRPC v11 async-generator subscription result into a v10
 * `@trpc/server/observable` Observable so electron-trpc v1.0.0-alpha.0
 * (which still consumes subscriptions via `isObservable(result)` +
 * `result.subscribe({next,error,complete})`) can drive the stream.
 *
 * The returned observable:
 *  - iterates the async iterable on subscribe, emitting each yielded
 *    value via `emit.next`.
 *  - calls `emit.complete()` when the iterable ends normally.
 *  - calls `emit.error(err)` with whatever the iterable threw.
 *  - invokes `iter.return?.()` on unsubscribe to release generator
 *    resources (closes server-side watchers held inside the generator
 *    body — e.g. llama-server log tail fds).
 */
function asyncIterableToObservable<T>(iter: AsyncIterable<T>): Observable<T, unknown> {
  return observable<T>((emit) => {
    const state = { cancelled: false };
    const iterator = iter[Symbol.asyncIterator]();
    void (async (): Promise<void> => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (state.cancelled) return;
          if (next.done) {
            emit.complete();
            return;
          }
          emit.next(next.value);
        }
      } catch (err) {
        if (!state.cancelled) emit.error(err);
      }
    })();
    return (): void => {
      state.cancelled = true;
      try {
        void iterator.return?.(undefined);
      } catch {
        // best effort
      }
    };
  });
}

/**
 * Runtime override for the UI's active node. Separate from kubeconfig's
 * `currentContext.defaultNode` so switching the renderer's active node
 * doesn't also silently change the CLI's default. When `null` the
 * dispatcher falls back to kubeconfig (matches the CLI behavior).
 */
let activeNodeOverride: string | null = null;

function setActiveNodeOverride(name: string | null): void {
  activeNodeOverride = name;
}
function getActiveNodeOverride(): string | null {
  return activeNodeOverride;
}

/**
 * Test-only helper — resets the module-level active-node override to
 * `null`. Tests that exercise the UI override path leave state behind
 * otherwise, which leaks into later tests that expect kubeconfig-only
 * dispatch semantics.
 */
export function __resetActiveNodeOverrideForTests(): void {
  activeNodeOverride = null;
}

/**
 * Typed UI-only sub-router. Declared up-front so the renderer's
 * `AppRouter` picks up `uiSetActiveNode` / `uiGetActiveNode` with full
 * per-procedure inference. These procedures never hit the base router
 * and never forward; `CONTROL_PLANE_ONLY` blocks accidental routing.
 */
const uiRouter = t.router({
  uiCrossNodeOpsSessionSearch: t.procedure
    .input(
      z.object({
        query: z.string().min(1),
        perNodeTimeoutMs: z.number().int().positive().max(30000).optional(),
      }),
    )
    .query(async ({ input, signal }) => {
      type SessionSearchHit = {
        sessionId: string;
        goal: string;
        status: "live" | "done" | "refused" | "aborted";
        startedAt: string;
        matches: { where: string; snippet: string; spans: { start: number; end: number }[] }[];
        score: number;
        originNode?: string;
      };
      const cfg = kubecfg.loadConfig();
      const ctx = kubecfg.currentContext(cfg);
      const user = cfg.users.find((u) => u.name === ctx.user);
      if (!user) return { hits: [], unreachableNodes: [] };
      const activeName = getActiveNodeOverride() ?? ctx.defaultNode;
      const peers = listAgentNodes(cfg, activeName);
      const result = await fanOutSurface<SessionSearchHit>({
        nodes: peers,
        perNodeFetch: async (node, peerSignal) => {
          const client = getPeerClient(node, user) as {
            opsSessionSearch: {
              query: (
                i: { query: string },
                o?: { signal?: AbortSignal },
              ) => Promise<{ hits: SessionSearchHit[] }>;
            };
          };
          const r = await client.opsSessionSearch.query(
            { query: input.query },
            { signal: peerSignal },
          );
          return r.hits.map((h) => ({ ...h, originNode: node.name }));
        },
        perNodeTimeoutMs: input.perNodeTimeoutMs ?? 2000,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        hits: result.hits,
        unreachableNodes: result.failures.map((f) => f.nodeName),
      };
    }),

  uiCrossNodeLogsSearch: t.procedure
    .input(
      z.object({
        query: z.string().min(1),
        perNodeTimeoutMs: z.number().int().positive().max(30000).optional(),
      }),
    )
    .query(async ({ input, signal }) => {
      const cfg = kubecfg.loadConfig();
      const ctx = kubecfg.currentContext(cfg);
      const user = cfg.users.find((u) => u.name === ctx.user);
      if (!user) return { hits: [], unreachableNodes: [] };
      const activeName = getActiveNodeOverride() ?? ctx.defaultNode;
      const peers = listAgentNodes(cfg, activeName);
      const result = await fanOutSurface<{
        fileLabel: string;
        filePath: string;
        matches: {
          lineNumber: number;
          where: string;
          snippet: string;
          spans: { start: number; end: number }[];
        }[];
        score: number;
        originNode?: string;
      }>({
        nodes: peers,
        perNodeFetch: async (node, peerSignal) => {
          const client = getPeerClient(node, user) as {
            logsSearch: {
              query: (
                i: { query: string },
                o?: { signal?: AbortSignal },
              ) => Promise<{
                hits: {
                  fileLabel: string;
                  filePath: string;
                  matches: {
                    lineNumber: number;
                    where: string;
                    snippet: string;
                    spans: { start: number; end: number }[];
                  }[];
                  score: number;
                }[];
              }>;
            };
          };
          const r = await client.logsSearch.query({ query: input.query }, { signal: peerSignal });
          return r.hits.map((h) => ({ ...h, originNode: node.name }));
        },
        perNodeTimeoutMs: input.perNodeTimeoutMs ?? 2000,
        ...(signal !== undefined ? { signal } : {}),
      });
      return {
        hits: result.hits,
        unreachableNodes: result.failures.map((f) => f.nodeName),
      };
    }),

  uiSetActiveNode: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => {
      setActiveNodeOverride(input.name);
      return { ok: true as const, name: input.name };
    }),
  uiGetActiveNode: t.procedure.query(() => ({
    name: activeNodeOverride,
  })),
  /**
   * Native directory picker — opens the OS's folder-chooser dialog
   * via Electron's dialog API. Used by the projects module's
   * create-project form so operators don't have to type absolute
   * paths by hand. Returns null when cancelled.
   */
  uiPickDirectory: t.procedure
    .input(
      z
        .object({
          title: z.string().optional(),
          defaultPath: z.string().optional(),
        })
        .optional(),
    )
    .mutation(async ({ input }) => {
      // Lazy-import so CLI consumers of the remote router don't pull
      // in Electron's main-process `dialog` module by accident.
      const { dialog, BrowserWindow } = await import("electron");
      const focused = BrowserWindow.getFocusedWindow();
      const result = focused
        ? await dialog.showOpenDialog(focused, {
            title: input?.title ?? "Pick a project directory",
            ...(input?.defaultPath !== undefined ? { defaultPath: input.defaultPath } : {}),
            properties: ["openDirectory", "createDirectory"],
          })
        : await dialog.showOpenDialog({
            title: input?.title ?? "Pick a project directory",
            ...(input?.defaultPath !== undefined ? { defaultPath: input.defaultPath } : {}),
            properties: ["openDirectory", "createDirectory"],
          });
      const [firstPath] = result.filePaths;
      if (result.canceled || !firstPath) return null;
      return firstPath;
    }),
  /**
   * Scan `root` for directories that look like git checkouts —
   * i.e. contain a `.git/` subdirectory. Non-recursive beyond the
   * first level by default (operators usually organise repos flat);
   * `maxDepth` opts into deeper walks for tools-in-subdir layouts.
   *
   * Returns up to `limit` results sorted by mtime (most recent
   * first) so the UI's quick-pick list shows the repos the operator
   * actually touched lately.
   */
  uiScanGitRepos: t.procedure
    .input(
      z.object({
        root: z.string().min(1),
        maxDepth: z.number().int().min(1).max(4).default(2),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ input }) => {
      const { existsSync } = await import("node:fs");
      const { readdir, stat } = await import("node:fs/promises");
      const { join } = await import("node:path");
      // Under a hermetic test profile, reroot `~` to the profile dir —
      // the operator's real home (and its git repos) must not leak into
      // audit/CI renders. Same philosophy as env.ts's testProfileDefaults:
      // every machine-specific path gets rerooted under the profile.
      const home =
        process.env["LLAMACTL_TEST_PROFILE"] && process.env["LLAMACTL_TEST_PROFILE"].length > 0
          ? process.env["LLAMACTL_TEST_PROFILE"]
          : (process.env["HOME"] ?? "");
      const expandedRoot = input.root.startsWith("~/")
        ? input.root.replace(/^~/, home)
        : input.root;
      if (!existsSync(expandedRoot)) {
        return { root: expandedRoot, repos: [] };
      }
      interface Entry {
        path: string;
        name: string;
        mtimeMs: number;
      }
      const hits: Entry[] = [];
      const listDirOrNull = async (dir: string): Promise<string[] | null> => {
        try {
          return await readdir(dir);
        } catch {
          return null;
        }
      };
      const recordRepo = async (dir: string): Promise<void> => {
        try {
          const st = await stat(dir);
          hits.push({
            path: dir,
            name: dir.split("/").slice(-1)[0] ?? dir,
            mtimeMs: st.mtimeMs,
          });
        } catch {
          /* unreadable — skip */
        }
      };
      const isDirectory = async (child: string): Promise<boolean> => {
        try {
          return (await stat(child)).isDirectory();
        } catch {
          return false;
        }
      };
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > input.maxDepth) return;
        const items = await listDirOrNull(dir);
        if (items === null) return;
        // If this dir is itself a repo, don't descend (avoid
        // returning submodules + siblings with the same mtime).
        if (items.includes(".git")) {
          await recordRepo(dir);
          return;
        }
        for (const item of items) {
          if (item.startsWith(".") || item === "node_modules") continue;
          const child = join(dir, item);
          if (await isDirectory(child)) await walk(child, depth + 1);
        }
      };
      await walk(expandedRoot, 0);
      hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
      return {
        root: expandedRoot,
        repos: hits.slice(0, input.limit).map((h) => ({
          path: h.path,
          name: h.name,
          mtimeMs: h.mtimeMs,
        })),
      };
    }),
});

/**
 * Test-only helper — clears the pinned-client cache so tests that
 * rotate tokens or swap cert fingerprints see fresh state. Paired
 * with `__resetActiveNodeOverrideForTests`.
 */
export function __resetClientCacheForTests(): void {
  __resetDispatchClientCacheForTests();
}

type PeerClientFactory = (node: ClusterNode) => unknown;
let peerClientFactoryOverride: PeerClientFactory | null = null;

export function __setPeerClientFactoryForTests(factory: PeerClientFactory): void {
  peerClientFactoryOverride = factory;
}
export function __resetPeerClientFactoryForTests(): void {
  peerClientFactoryOverride = null;
}

function getPeerClient(node: ClusterNode, user: KubeUser): unknown {
  if (peerClientFactoryOverride) return peerClientFactoryOverride(node);
  const target: DispatchTarget = {
    kind: "remote",
    node: {
      name: node.name,
      endpoint: node.endpoint,
      certificate: node.certificate ?? null,
      certificateFingerprint: node.certificateFingerprint ?? null,
      ...(node.tlsServerName !== undefined ? { tlsServerName: node.tlsServerName } : {}),
    },
    token: kubecfg.resolveToken(user),
  };
  return getDispatchClient(target, makeNodePinnedFetch);
}

/**
 * Build the dispatching router from `@llamactl/remote`'s
 * `buildDispatchRouter` (which introspects the base router and wraps
 * every procedure), then merge in the UI-only sub-router and apply the
 * electron-trpc v10 compat shims. The renderer imports the inferred
 * return type as its `AppRouter`, so every call — base-forwarded or
 * UI-local — has full tRPC inference.
 *
 * `fetchFactory` defaults to the undici-backed Node factory; tests
 * running under Bun can inject the Bun-native one (`makePinnedFetch`
 * from `@llamactl/remote`) so the self-signed cert round-trips
 * without needing Node's HTTPS agent.
 */
export function buildDispatcherRouter(
  fetchFactory: PinnedFetchFactory = makeNodePinnedFetch,
): BaseAppRouter {
  const wrappedBase = buildDispatchRouter({
    fetchFactory,
    nodeFromCtx: () => activeNodeOverride,
    onUnresolvable: "local",
  });
  // Cast the dispatch router to the base AppRouter type, then merge
  // with the typed UI router. The resulting type surfaces every
  // forwarded procedure AND the UI procedures to the renderer.
  // mergeRouters copies the router config from routerList[0], so the
  // merged router now carries the dispatch router's sse.ping — inert
  // over IPC.
  const merged = t.mergeRouters(
    wrappedBase as unknown as BaseAppRouter,
    uiRouter,
  ) as unknown as RouterWithCompat;
  // electron-trpc v1.0.0-alpha.0's main-side `callProcedure` wires
  // procedures in two v10-shaped ways that tRPC v11 no longer supports:
  //
  //   1. It checks `procedures[path]._def[type]` as a boolean (v10)
  //      rather than `_def.type === 'mutation'` (v11). Without the
  //      v10-style booleans, every mutation call throws
  //      `No "mutation"-procedure on path "<name>"`.
  //
  //   2. It invokes the procedure with `{ctx, path, procedures,
  //      rawInput, type}` — no `getRawInput` field. tRPC v11's
  //      procedure caller checks `if (!("getRawInput" in opts)) throw`,
  //      so we synthesize the missing field by returning a constant
  //      from a wrapped caller.
  //
  // Backfilling both shapes in place makes the alpha routes work
  // without forking electron-trpc.
  const procsDef = merged._def.procedures as Record<string, CompatProcedure>;
  for (const [path, origProc] of Object.entries(procsDef)) {
    const d = origProc._def;
    switch (d.type) {
      case "query":
        d.query = true;
        break;
      case "mutation":
        d.mutation = true;
        break;
      case "subscription":
        d.subscription = true;
        break;
    }
    // Wrap with a v10-compat shim. The shim is callable both ways:
    // when invoked with v11's `ProcedureCallOptions` (from
    // createCaller) it passes through; when invoked with v10's
    // `{ctx, path, rawInput, type, procedures}` it back-fills
    // `getRawInput: () => rawInput`.
    //
    // For subscription procedures, v11 async-generator resolvers
    // return an AsyncIterable; electron-trpc alpha's IPC handler
    // still expects a v10 Observable (it calls `isObservable(result)`).
    // We convert AsyncIterable → Observable, but only when the call
    // is the v10-shape one — detected by the missing `getRawInput`
    // field. v11 createCaller paths (tests, future callers) keep the
    // AsyncIterable so they stay native.
    const isSubscription = d.type === "subscription";
    const callOriginal = origProc as (opts: ProcedureCallOptions<unknown>) => Promise<unknown>;
    const shim = (async (opts: ProcedureCallOptions<unknown> | V10ProcedureCallOptions) => {
      const isV10ShapeCall = !isProcedureCallOptions(opts);
      let callOpts: ProcedureCallOptions<unknown>;
      if (isV10ShapeCall) {
        const rawInput = opts.rawInput;
        callOpts = {
          ...opts,
          getRawInput: () => Promise.resolve(rawInput),
        } as ProcedureCallOptions<unknown>;
      } else {
        callOpts = opts;
      }
      const result = await callOriginal(callOpts);
      if (!isSubscription || !isV10ShapeCall) return result;
      return asyncIterableToObservable(result as AsyncIterable<unknown>);
    }) as CompatProcedure;
    shim._def = origProc._def;
    shim.procedure = origProc.procedure;
    shim.meta = d.meta;
    procsDef[path] = shim;
  }
  // electron-trpc v1.0.0-alpha.0's main-side IPC handler calls
  // `router.getErrorShape(...)` — a v10 API that tRPC v11 removed in
  // favor of the standalone `getErrorShape()` helper. Shim it here so
  // errors raised inside any procedure propagate to the renderer
  // instead of crashing the main process with "n.getErrorShape is not
  // a function".
  if (typeof merged.getErrorShape !== "function") {
    merged.getErrorShape = (opts: {
      error: unknown;
      type: "query" | "mutation" | "subscription" | "unknown";
      path: string | undefined;
      input: unknown;
      ctx: unknown;
    }): unknown =>
      getErrorShape({
        config: merged._def._config,
        error:
          opts.error instanceof TRPCError
            ? opts.error
            : new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: opts.error }),
        type: opts.type,
        path: opts.path,
        input: opts.input,
        ctx: typeof opts.ctx === "object" && opts.ctx !== null ? opts.ctx : undefined,
      });
  }
  return merged as unknown as BaseAppRouter;
}

/**
 * Exported type for the renderer's UI-only client. Carries just the
 * two procedures so the renderer can call `uiSetActiveNode` /
 * `uiGetActiveNode` through a small typed client without widening the
 * main `AppRouter` type (which would force a router-merge whose
 * inferred form references deep `@llamactl/core` paths and breaks
 * `composite: true` declaration emit in this workspace).
 */
export type UIRouter = typeof uiRouter;
