import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { createTRPCClient } from '@trpc/client';
import { z } from 'zod';
import * as kubecfg from './config/kubeconfig.js';
import { decodeBootstrap } from './config/agent-config.js';
import type { ClusterNode, Config } from './config/schema.js';
import * as workloadStoreMod from './workload/store.js';
import * as workloadApplyMod from './workload/apply.js';
import {
  ModelRunSpecSchema,
  type ModelRun,
} from './workload/schema.js';
import { buildPinnedLinks } from './client/links.js';

/**
 * Minimal structural type of a tRPC NodeClient limited to the methods
 * the workload procedures call. Declared inline here so router.ts does
 * not import `NodeClient` from `./client/node-client.js`, which would
 * re-introduce the `AppRouter → NodeClient → AppRouter` circular alias.
 * `applyOne`'s full `NodeClient` shape is structurally compatible — we
 * cast with `as unknown as` where applyOne expects the richer type.
 */
interface WorkloadNodeClient {
  serverStatus: { query(): Promise<{
    state: string;
    rel: string | null;
    extraArgs: string[];
    pid: number | null;
    endpoint: string;
    advertisedEndpoint?: string | null;
  }> };
  serverStop: { mutate(input?: { graceSeconds?: number }): Promise<unknown> };
  rpcServerStop: { mutate(input?: { graceSeconds?: number }): Promise<unknown> };
}

/**
 * Build a tRPC-client-shaped proxy over `router.createCaller({})` so
 * local workload ops can reuse the same `.query/.mutate/.subscribe`
 * surface as the remote tRPC client. Mirrors the proxy wrapper in
 * `client/node-client.ts` but lives here to avoid the AppRouter cycle.
 */
function localCallerProxy(): WorkloadNodeClient {
  // Deferred reference — at runtime `router` exists by the time the
  // helper is invoked from within a procedure body, even though at
  // module-load time the declaration below is still being evaluated.
  const getCaller = (): Record<string, (...a: unknown[]) => unknown> =>
    router.createCaller({}) as unknown as Record<string, (...a: unknown[]) => unknown>;
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      const invoke = (...args: unknown[]): unknown => {
        const caller = getCaller();
        const fn = caller[prop];
        if (typeof fn !== 'function') throw new Error(`unknown procedure '${prop}'`);
        return fn(...args);
      };
      return { query: invoke, mutate: invoke, subscribe: invoke };
    },
  };
  return new Proxy({}, handler) as unknown as WorkloadNodeClient;
}

function clientForNode(cfg: Config, nodeName: string): WorkloadNodeClient {
  const resolved = kubecfg.resolveNode(cfg, nodeName);
  if (resolved.node.endpoint.startsWith('inproc://')) {
    return localCallerProxy();
  }
  const token = kubecfg.resolveToken(resolved.user);
  const trpc = createTRPCClient({
    links: buildPinnedLinks(resolved.node, token),
  });
  return trpc as unknown as WorkloadNodeClient;
}
import {
  autotune as autotuneMod,
  bench,
  candidateTest as candidateMod,
  catalog,
  discovery,
  env as envMod,
  keepAlive as keepAliveMod,
  lmstudio as lmstudioMod,
  nodeFacts as nodeFactsMod,
  presets,
  pull,
  recommendations,
  rpcServer as rpcServerMod,
  server as serverMod,
  serverLogs as serverLogsMod,
  target as targetMod,
  uninstall as uninstallMod,
  type MachineProfile,
} from '@llamactl/core';

type PullStreamEvent =
  | pull.PullEvent
  | { type: 'done'; result: pull.PullFileResult }
  | { type: 'done-candidate'; result: pull.PullCandidateResult };

type BenchStreamEvent =
  | bench.BenchEvent
  | { type: 'done-preset'; result: bench.BenchPresetResult }
  | { type: 'done-vision'; result: bench.BenchVisionResult };

type ServerStartEvent =
  | serverMod.ServerEvent
  | { type: 'done'; result: serverMod.StartServerResult };

type CandidateStreamEvent =
  | candidateMod.CandidateTestEvent
  | { type: 'done-candidate-test'; result: candidateMod.CandidateTestResult };

// Plain JSON serialisation — the core read surface returns POJOs only
// (strings, numbers, arrays, nested objects). We'd swap in superjson if
// we started returning Date/Map/Set, but electron-trpc v0.7 doesn't pass
// a transformer through ipcLink, so this keeps the pipeline uncomplicated.
const t = initTRPC.create();

/**
 * Reach a remote agent's /trpc/nodeFacts endpoint using a pinned TLS
 * cert and bearer token, returning the parsed facts. Inlined here so
 * router.ts doesn't pull createRemoteNodeClient from ./client/ (that
 * module imports AppRouter, which depends on router.ts — TypeScript
 * refuses to resolve the circular alias).
 */
async function probeNodeFacts(opts: {
  url: string;
  token: string;
  certificate: string | null;
  certificateFingerprint: string | null;
}): Promise<nodeFactsMod.NodeFacts> {
  const { fingerprintsEqual, computeFingerprint } = await import('./server/tls.js');
  if (opts.certificate && opts.certificateFingerprint) {
    const actual = computeFingerprint(opts.certificate);
    if (!fingerprintsEqual(actual, opts.certificateFingerprint)) {
      throw new Error(
        `certificate fingerprint mismatch: expected ${opts.certificateFingerprint}, got ${actual}`,
      );
    }
  }
  const ca = opts.certificate;
  const res = await fetch(`${opts.url}/trpc/nodeFacts?input=${encodeURIComponent(JSON.stringify({}))}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${opts.token}` },
    ...(ca ? ({ tls: { ca } } as Record<string, unknown>) : {}),
  } as RequestInit);
  if (!res.ok) {
    throw new Error(`probe HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  // tRPC v11 GET-procedure responses wrap the payload as { result: { data: ... } }.
  const body = (await res.json()) as { result?: { data?: nodeFactsMod.NodeFacts } };
  if (!body.result?.data) {
    throw new Error('probe response missing result.data');
  }
  return body.result.data;
}

export const router = t.router({
  env: t.procedure.query(() => envMod.resolveEnv()),

  nodeFacts: t.procedure.query(() => nodeFactsMod.collectNodeFacts()),

  // ---- node management (kubeconfig + reachability) ----------------------

  nodeList: t.procedure.query(() => {
    const cfg = kubecfg.loadConfig();
    const ctx = kubecfg.currentContext(cfg);
    const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
    return {
      context: ctx.name,
      cluster: ctx.cluster,
      defaultNode: ctx.defaultNode,
      nodes: cluster?.nodes ?? [],
    };
  }),

  nodeTest: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.name);
      const token = kubecfg.resolveToken(resolved.user);
      const node = resolved.node;
      if (node.endpoint.startsWith('inproc://')) {
        return { ok: true as const, facts: nodeFactsMod.collectNodeFacts() };
      }
      try {
        const facts = await probeNodeFacts({
          url: node.endpoint,
          token,
          certificate: node.certificate ?? null,
          certificateFingerprint: node.certificateFingerprint ?? null,
        });
        return { ok: true as const, facts };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    }),

  nodeAdd: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        bootstrap: z.string().min(1),
        force: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const decoded = decodeBootstrap(input.bootstrap);
      const force = input.force ?? false;

      if (!force) {
        try {
          await probeNodeFacts({
            url: decoded.url,
            token: decoded.token,
            certificate: decoded.certificate,
            certificateFingerprint: decoded.fingerprint,
          });
        } catch (err) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `reachability check failed: ${(err as Error).message}`,
          });
        }
      }

      const cfgPath = kubecfg.defaultConfigPath();
      let cfg = kubecfg.loadConfig(cfgPath);
      const ctx = kubecfg.currentContext(cfg);

      cfg = {
        ...cfg,
        users: cfg.users.map((u) =>
          u.name === ctx.user ? { ...u, token: decoded.token } : u,
        ),
      };
      const entry: ClusterNode = {
        name: input.name,
        endpoint: decoded.url,
        certificateFingerprint: decoded.fingerprint,
        certificate: decoded.certificate,
      };
      cfg = kubecfg.upsertNode(cfg, ctx.cluster, entry);
      kubecfg.saveConfig(cfg, cfgPath);
      return { ok: true as const, name: input.name, endpoint: decoded.url };
    }),

  nodeRemove: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => {
      const cfgPath = kubecfg.defaultConfigPath();
      let cfg = kubecfg.loadConfig(cfgPath);
      const ctx = kubecfg.currentContext(cfg);
      cfg = kubecfg.removeNode(cfg, ctx.cluster, input.name);
      kubecfg.saveConfig(cfg, cfgPath);
      return { ok: true as const };
    }),

  // ---- workload management --------------------------------------------

  workloadList: t.procedure.query(async () => {
    const manifests = workloadStoreMod.listWorkloads();
    const cfg = kubecfg.loadConfig();
    const rows = await Promise.all(
      manifests.map(async (manifest) => {
        const nodeName = manifest.spec.node;
        let phase: 'Running' | 'Stopped' | 'Mismatch' | 'Unreachable' = 'Stopped';
        let endpoint: string | null = null;
        try {
          const client = clientForNode(cfg, nodeName);
          const status = await client.serverStatus.query();
          const desired = manifest.spec.target.value;
          if (status.state === 'up' && status.rel === desired) phase = 'Running';
          else if (status.state === 'up' && status.rel !== desired) phase = 'Mismatch';
          endpoint = status.advertisedEndpoint ?? status.endpoint;
        } catch {
          phase = 'Unreachable';
        }
        return {
          name: manifest.metadata.name,
          node: nodeName,
          rel: manifest.spec.target.value,
          phase,
          endpoint,
          status: manifest.status ?? null,
        };
      }),
    );
    return rows;
  }),

  workloadDescribe: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const manifest = workloadStoreMod.loadWorkloadByName(input.name);
      const cfg = kubecfg.loadConfig();
      let liveStatus: unknown;
      try {
        const client = clientForNode(cfg, manifest.spec.node);
        liveStatus = await client.serverStatus.query();
      } catch (err) {
        liveStatus = { error: (err as Error).message };
      }
      return { manifest, liveStatus };
    }),

  workloadApply: t.procedure
    .input(z.object({ yaml: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const manifest: ModelRun = workloadStoreMod.parseWorkload(input.yaml);
      const cfg = kubecfg.loadConfig();
      // applyOne's NodeClient type pulls AppRouter → NodeClient → AppRouter
      // at the type level. clientForNode returns a structurally-compatible
      // surface (serverStatus/serverStop/rpcServerStop + the subscription
      // helpers for serverStart/rpcServerStart arrive from the pinned tRPC
      // client on the remote path; local path wraps core directly). The
      // double-cast erases the cycle without introducing a runtime gap.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await workloadApplyMod.applyOne(manifest, (nodeName) =>
        clientForNode(cfg, nodeName) as unknown as any,
      );
      if (result.error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error });
      }
      const persisted: ModelRun = { ...manifest, status: result.statusSection };
      const savedPath = workloadStoreMod.saveWorkload(persisted);
      return {
        action: result.action,
        path: savedPath,
        status: result.statusSection,
        name: manifest.metadata.name,
        node: manifest.spec.node,
      };
    }),

  workloadDelete: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        keepRunning: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const manifest = workloadStoreMod.loadWorkloadByName(input.name);
      const stops: string[] = [];
      if (!input.keepRunning) {
        const cfg = kubecfg.loadConfig();
        try {
          const client = clientForNode(cfg, manifest.spec.node);
          const status = await client.serverStatus.query();
          if (status.state === 'up' && status.rel === manifest.spec.target.value) {
            await client.serverStop.mutate({ graceSeconds: 5 });
            stops.push(`stopped llama-server on ${manifest.spec.node}`);
          }
        } catch (err) {
          stops.push(`warning: coordinator ${manifest.spec.node}: ${(err as Error).message}`);
        }
        for (const worker of [...manifest.spec.workers].reverse()) {
          try {
            const wc = clientForNode(cfg, worker.node);
            await wc.rpcServerStop.mutate({ graceSeconds: 3 });
            stops.push(`stopped rpc-server on ${worker.node}`);
          } catch (err) {
            stops.push(`warning: worker ${worker.node}: ${(err as Error).message}`);
          }
        }
      }
      const removed = workloadStoreMod.deleteWorkload(input.name);
      return { ok: removed, name: input.name, stops };
    }),

  workloadValidate: t.procedure
    .input(z.object({ yaml: z.string().min(1) }))
    .query(({ input }) => {
      try {
        const manifest = workloadStoreMod.parseWorkload(input.yaml);
        return { ok: true as const, manifest };
      } catch (err) {
        return { ok: false as const, error: (err as Error).message };
      }
    }),

  // Export the spec schema shape so the UI can build default manifests
  // from a model + node without re-declaring the whole zod graph.
  // We only return the JSON string of a template here; the real schema
  // is still validated inside workloadApply.
  workloadTemplate: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        node: z.string().min(1),
        target: z.string().min(1),
        targetKind: z.enum(['rel', 'alias']).default('rel'),
        extraArgs: z.array(z.string()).default([]),
        timeoutSeconds: z.number().int().positive().default(60),
      }),
    )
    .query(({ input }) => {
      const spec = ModelRunSpecSchema.parse({
        node: input.node,
        target: { kind: input.targetKind, value: input.target },
        extraArgs: input.extraArgs,
        timeoutSeconds: input.timeoutSeconds,
      });
      const manifest: ModelRun = {
        apiVersion: 'llamactl/v1',
        kind: 'ModelRun',
        metadata: { name: input.name, labels: {} },
        spec,
      };
      return manifest;
    }),

  catalogList: t.procedure
    .input(z.enum(['all', 'builtin', 'custom']).default('all'))
    .query(({ input }) => catalog.listCatalog(input)),

  catalogStatus: t.procedure
    .input(z.string().min(1))
    .query(async ({ input }) => {
      const entry = catalog.findByRel(input);
      // Class resolution intentionally lives in the renderer's dedicated
      // inspector view later; for now surface the catalog row + quant.
      return {
        rel: input,
        entry,
        quant: (await import('@llamactl/core')).quant.quantFromRel(input),
      };
    }),

  benchShow: t.procedure
    .input(z.string().min(1))
    .query(({ input }) => {
      const resolved = envMod.resolveEnv();
      const rows = bench.readBenchProfiles(bench.benchProfileFile(resolved));
      const machine = bench.machineLabel(resolved);
      const mode = bench.defaultModeForRel(input, resolved);
      const ctx = resolved.LLAMA_CPP_GEMMA_CTX_SIZE;
      const build = ''; // resolved by caller if they care
      const latest = bench.findLatestProfile(rows, {
        machine,
        rel: input,
        mode,
        ctx,
        build,
      });
      if (latest) return { kind: 'current' as const, row: latest };
      const legacy = bench.findLegacyProfile(rows, input);
      if (legacy) return { kind: 'legacy' as const, row: legacy };
      return { kind: 'none' as const };
    }),

  benchCompare: t.procedure
    .input(
      z
        .object({
          classFilter: z.string().optional(),
          scopeFilter: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) =>
      bench.benchCompare({
        classFilter: (input?.classFilter ?? 'all') as
          | 'multimodal'
          | 'reasoning'
          | 'general'
          | 'custom'
          | 'all',
        scopeFilter: input?.scopeFilter ?? 'all',
      }),
    ),

  recommendations: t.procedure
    .input(z.string().default('current'))
    .query(async ({ input }) => {
      const profiles = recommendations.expandRequestedProfile(input);
      const out = [] as Array<{
        profile: MachineProfile;
        rows: recommendations.RecommendationRow[];
      }>;
      for (const profile of profiles) {
        const rows = await recommendations.recommendationsWithHf(profile);
        out.push({ profile, rows });
      }
      return out;
    }),

  promotions: t.procedure.query(() => {
    const resolved = envMod.resolveEnv();
    return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
  }),

  promote: t.procedure
    .input(
      z.object({
        profile: z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']),
        preset: z.enum(['best', 'vision', 'balanced', 'fast']),
        rel: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      presets.writePresetOverride(input.profile, input.preset, input.rel);
      const resolved = envMod.resolveEnv();
      return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
    }),

  promoteDelete: t.procedure
    .input(
      z.object({
        profile: z.enum(['mac-mini-16g', 'balanced', 'macbook-pro-48g']),
        preset: z.enum(['best', 'vision', 'balanced', 'fast']),
      }),
    )
    .mutation(({ input }) => {
      presets.deletePresetOverride(input.profile, input.preset);
      const resolved = envMod.resolveEnv();
      return presets.readPresetOverrides(resolved.LOCAL_AI_PRESET_OVERRIDES_FILE);
    }),

  serverStatus: t.procedure.query(async () => serverMod.serverStatus()),

  serverLogs: t.procedure
    .input(
      z
        .object({
          lines: z.number().int().min(0).max(1000).optional(),
          follow: z.boolean().optional(),
        })
        .optional(),
    )
    .subscription(({ input }) => {
      return observable<serverLogsMod.LogLineEvent>((emit) => {
        const controller = new AbortController();
        void (async () => {
          try {
            await serverLogsMod.tailServerLog({
              lines: input?.lines,
              follow: input?.follow,
              signal: controller.signal,
              onLine: (e) => emit.next(e),
            });
            emit.complete();
          } catch (err) {
            emit.error(err);
          }
        })();
        return () => controller.abort();
      });
    }),

  serverStop: t.procedure
    .input(z.object({ graceSeconds: z.number().int().positive().max(60).optional() }).optional())
    .mutation(async ({ input }) =>
      serverMod.stopServer({ graceSeconds: input?.graceSeconds }),
    ),

  serverStart: t.procedure
    .input(
      z.object({
        target: z.string().min(1),
        extraArgs: z.array(z.string()).optional(),
        timeoutSeconds: z.number().int().positive().max(600).optional(),
        skipTuned: z.boolean().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<ServerStartEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await serverMod.startServer({
              target: input.target,
              extraArgs: input.extraArgs,
              timeoutSeconds: input.timeoutSeconds,
              skipTuned: input.skipTuned,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (cancelled) return;
            emit.next({ type: 'done', result });
            emit.complete();
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  lmstudioScan: t.procedure
    .input(z.object({ root: z.string().optional() }).optional())
    .query(({ input }) => lmstudioMod.scanLMStudio({ root: input?.root })),

  lmstudioPlan: t.procedure
    .input(
      z
        .object({
          root: z.string().optional(),
          link: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ input }) =>
      lmstudioMod.planImport({ root: input?.root, link: input?.link }),
    ),

  lmstudioImport: t.procedure
    .input(
      z.object({
        root: z.string().optional(),
        link: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) =>
      lmstudioMod.applyImport({ root: input.root, link: input.link, apply: true }),
    ),

  keepAliveStatus: t.procedure.query(() => keepAliveMod.keepAliveStatus()),

  rpcServerStatus: t.procedure.query(async () => rpcServerMod.rpcServerStatus()),

  rpcServerStop: t.procedure
    .input(
      z.object({ graceSeconds: z.number().int().positive().max(60).optional() }).optional(),
    )
    .mutation(async ({ input }) =>
      rpcServerMod.stopRpcServer({ graceSeconds: input?.graceSeconds }),
    ),

  rpcServerStart: t.procedure
    .input(
      z.object({
        host: z.string().min(1).optional(),
        port: z.number().int().min(1).max(65535),
        modelPath: z.string().optional(),
        extraArgs: z.array(z.string()).optional(),
        timeoutSeconds: z.number().int().positive().max(300).optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<
        rpcServerMod.RpcServerEvent | { type: 'done'; result: rpcServerMod.StartRpcServerResult }
      >((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await rpcServerMod.startRpcServer({
              ...input,
              signal: controller.signal,
              onEvent: (e) => emit.next(e),
            });
            if (!cancelled) {
              emit.next({ type: 'done', result });
              emit.complete();
            }
          } catch (err) {
            emit.error(err);
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  keepAliveStop: t.procedure
    .input(
      z.object({ graceSeconds: z.number().int().positive().max(60).optional() }).optional(),
    )
    .mutation(async ({ input }) =>
      keepAliveMod.stopKeepAlive({ graceSeconds: input?.graceSeconds }),
    ),

  keepAliveStart: t.procedure
    .input(z.object({ target: z.string().min(1) }))
    .mutation(async ({ input }) => {
      // Spawn a detached `llamactl keep-alive worker <target>` child by
      // shelling out to `bun` with the CLI entry. Matches what
      // \`llamactl keep-alive start\` does from a shell session.
      const { spawn } = await import('node:child_process');
      const { join } = await import('node:path');
      const resolved = envMod.resolveEnv();
      const existing = keepAliveMod.readKeepAlivePid(resolved);
      if (existing !== null) {
        return {
          ok: false,
          pid: existing,
          error: `keep-alive already running (pid=${existing})`,
        };
      }
      const llamactlHome = process.env.LLAMACTL_HOME
        ?? join(resolved.DEV_STORAGE, 'repos', 'personal', 'llamactl');
      const entry = join(llamactlHome, 'packages', 'cli', 'src', 'bin.ts');
      const child = spawn('bun', [entry, 'keep-alive', 'worker', input.target], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env },
      });
      child.unref();
      const startedAt = Date.now();
      let pid: number | null = null;
      while (Date.now() - startedAt < 2000) {
        pid = keepAliveMod.readKeepAlivePid(resolved);
        if (pid !== null) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return {
        ok: pid !== null,
        pid,
        error: pid === null ? 'supervisor did not register a PID within 2s' : undefined,
      };
    }),

  candidateTestRun: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().optional(),
        profile: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<CandidateStreamEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await candidateMod.candidateTest({
              repo: input.repo,
              file: input.file,
              profile: input.profile,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (cancelled) return;
            if ('error' in result) {
              emit.error(new Error(result.error));
              return;
            }
            emit.next({ type: 'done-candidate-test', result });
            emit.complete();
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  uninstall: t.procedure
    .input(
      z.object({
        rel: z.string().min(1),
        force: z.boolean().optional(),
      }),
    )
    .mutation(({ input }) => {
      // Surface the structured report as-is. `code` is 0 on success,
      // non-zero on refusal (e.g. non-candidate scope without --force),
      // with `error` carrying the human message the CLI prints.
      return uninstallMod.uninstall({ rel: input.rel, force: input.force });
    }),

  autotuneAfterPull: t.procedure
    .input(
      z.object({
        rel: z.string().min(1),
        wasMissing: z.boolean(),
      }),
    )
    .subscription(({ input }) => {
      return observable<
        bench.BenchEvent | { type: 'done-tune'; result: autotuneMod.MaybeTuneAfterPullResult }
      >((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await autotuneMod.maybeTuneAfterPull({
              rel: input.rel,
              wasMissing: input.wasMissing,
              signal: controller.signal,
              onEvent: (e) => emit.next(e),
            });
            if (!cancelled) {
              emit.next({ type: 'done-tune', result });
              emit.complete();
            }
          } catch (err) {
            emit.error(err);
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  pullFile: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().min(1),
      }),
    )
    .subscription(({ input }) => {
      return observable<PullStreamEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await pull.pullRepoFile({
              repo: input.repo,
              file: input.file,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (!cancelled) {
              emit.next({ type: 'done', result });
              emit.complete();
            }
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  benchHistory: t.procedure
    .input(
      z
        .object({
          rel: z.string().optional(),
          limit: z.number().int().positive().max(500).optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      const resolved = envMod.resolveEnv();
      const rows = bench.readBenchHistory(bench.benchHistoryFile(resolved));
      const limit = input?.limit ?? 50;
      const filter = input?.rel;
      const merged = [
        ...rows.current.map((r) => ({
          updated_at: r.updated_at,
          machine: r.machine,
          rel: r.rel,
          mode: r.mode,
          ctx: r.ctx,
          build: r.build,
          profile: r.profile,
          gen_ts: r.gen_ts,
          prompt_ts: r.prompt_ts,
          launch_args: r.launch_args,
          kind: 'current' as const,
        })),
        ...rows.legacy.map((r) => ({
          updated_at: r.updated_at,
          machine: 'legacy',
          rel: r.rel,
          mode: 'legacy',
          ctx: 'legacy',
          build: 'legacy',
          profile: r.profile,
          gen_ts: r.gen_ts,
          prompt_ts: r.prompt_ts,
          launch_args: r.launch_args,
          kind: 'legacy' as const,
        })),
      ];
      const filtered = filter ? merged.filter((r) => r.rel === filter) : merged;
      filtered.sort((a, b) => a.updated_at.localeCompare(b.updated_at));
      return filtered.slice(-limit);
    }),

  benchVisionRows: t.procedure.query(() => {
    const resolved = envMod.resolveEnv();
    return bench.readBenchVision(bench.benchVisionFile(resolved));
  }),

  benchPresetRun: t.procedure
    .input(
      z.object({
        target: z.string().min(1),
        mode: z.enum(['auto', 'text', 'vision']).optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<BenchStreamEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await bench.benchPreset({
              target: input.target,
              mode: input.mode,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (cancelled) return;
            if ('error' in result) {
              emit.error(new Error(result.error));
              return;
            }
            emit.next({ type: 'done-preset', result });
            emit.complete();
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  benchVisionRun: t.procedure
    .input(z.object({ target: z.string().min(1) }))
    .subscription(({ input }) => {
      return observable<BenchStreamEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await bench.benchVision({
              target: input.target,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (cancelled) return;
            if ('error' in result) {
              emit.error(new Error(result.error));
              return;
            }
            emit.next({ type: 'done-vision', result });
            emit.complete();
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  pullCandidate: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().optional(),
        profile: z.string().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<PullStreamEvent>((emit) => {
        let cancelled = false;
        const controller = new AbortController();
        void (async () => {
          try {
            const result = await pull.pullCandidate({
              repo: input.repo,
              file: input.file,
              profile: input.profile,
              signal: controller.signal,
              onEvent: (e) => {
                if (!cancelled) emit.next(e);
              },
            });
            if (cancelled) return;
            if ('error' in result) {
              emit.error(new Error(result.error));
              return;
            }
            emit.next({ type: 'done-candidate', result });
            emit.complete();
          } catch (err) {
            if (!cancelled) {
              emit.error(err instanceof Error ? err : new Error(String(err)));
            }
          }
        })();
        return () => {
          cancelled = true;
          controller.abort();
        };
      });
    }),

  discover: t.procedure
    .input(
      z
        .object({
          filter: z.string().optional(),
          profile: z.string().optional(),
          limit: z.number().optional(),
        })
        .optional(),
    )
    .query(async ({ input }) =>
      discovery.discover({
        filter: input?.filter,
        requestedProfile: input?.profile,
        limit: input?.limit,
      }),
    ),

  resolveTarget: t.procedure
    .input(z.string())
    .query(({ input }) => targetMod.resolveTarget(input)),
});

export type AppRouter = typeof router;
