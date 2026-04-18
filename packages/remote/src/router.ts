import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import * as kubecfg from './config/kubeconfig.js';
import { decodeBootstrap } from './config/agent-config.js';
import type { ClusterNode } from './config/schema.js';
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
