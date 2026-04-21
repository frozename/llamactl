import { initTRPC, TRPCError } from '@trpc/server';
import { createTRPCClient } from '@trpc/client';
import { z } from 'zod';
import * as kubecfg from './config/kubeconfig.js';
import { decodeBootstrap } from './config/agent-config.js';
import * as infraLayoutMod from './infra/layout.js';
import * as infraInstallMod from './infra/install.js';
import * as infraServicesMod from './infra/services.js';
import type { ClusterNode, Config } from './config/schema.js';
import * as workloadStoreMod from './workload/store.js';
import * as workloadApplyMod from './workload/apply.js';
import * as reconcileLoopMod from './workload/reconcileLoop.js';
import * as benchScheduleMod from './bench/schedule.js';
import * as benchScheduleLoopMod from './bench/scheduleLoop.js';
import {
  ModelRunSpecSchema,
  type ModelRun,
} from './workload/schema.js';
import { buildPinnedLinks } from './client/links.js';
import {
  createLlmExecutor,
  runPlanner,
  stubPlannerExecutor,
  DEFAULT_ALLOWLIST,
  computeCostSnapshot,
  type PlannerExecutor,
  type PlannerToolDescriptor,
} from '@nova/mcp';
import { createOpenAICompatProvider } from '@nova/contracts';
import {
  decideGuardianAction,
  emptyCostGuardianConfig,
  loadCostGuardianConfig,
  defaultCostGuardianConfigPath,
  defaultCostJournalPath,
  type CostJournalEntry,
} from '@llamactl/agents';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  KNOWN_OPS_CHAT_TOOLS,
  dispatchOpsChatTool,
} from './ops-chat/dispatch.js';
import {
  appendOpsChatAudit,
  hashArguments,
  readOpsChatAudit,
  type OpsChatAuditEntry,
} from './ops-chat/audit.js';

/**
 * Router↔client circular-type escape hatch — the `AppRouter → NodeClient
 * → AppRouter` alias is unresolvable in TypeScript, so router.ts never
 * imports `NodeClient` from `./client/node-client.js`. Instead we route
 * workload forwarding through `WorkloadClient` (defined in
 * `./workload/apply.js`), which is structurally narrower than
 * `NodeClient` and carries no AppRouter reference.
 *
 * Same pattern applies elsewhere: if a router procedure ever needs to
 * call another tRPC client (remote or caller-proxy), give it a
 * hand-rolled structural interface. Importing the typed `NodeClient`
 * is always a cycle.
 */
/**
 * Union of every structural-client shape router.ts currently needs.
 * As new in-process orchestrators arrive (bench scheduler,
 * workload reconciler, …), their narrow client interface is added
 * to this intersection — the underlying runtime (`localCallerProxy`
 * or pinned tRPC) satisfies everything structurally, so this is a
 * pure type-level accumulator.
 */
type WorkloadNodeClient = workloadApplyMod.WorkloadClient &
  benchScheduleLoopMod.BenchClient;

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

/**
 * Bridge a callback-driven async worker into a tRPC v11 async-generator
 * subscription. Every `emit(ev)` becomes a yielded value; the generator
 * completes when `runner` resolves and throws when it rejects. Client
 * disconnects (`clientSignal.aborted`) propagate into `runner`'s signal
 * so in-flight work cancels cleanly.
 */
async function* bridgeEventStream<T>(
  clientSignal: AbortSignal,
  runner: (emit: (evt: T) => void, signal: AbortSignal) => Promise<void>,
): AsyncGenerator<T, void, unknown> {
  const controller = new AbortController();
  const onClientAbort = (): void => controller.abort();
  clientSignal.addEventListener('abort', onClientAbort);

  const queue: T[] = [];
  let finished = false;
  let err: unknown = null;
  let wake: (() => void) | null = null;
  const drain = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };

  const run = (async () => {
    try {
      await runner((ev) => {
        queue.push(ev);
        drain();
      }, controller.signal);
    } catch (e) {
      err = e;
    } finally {
      finished = true;
      drain();
    }
  })();

  try {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift() as T;
        continue;
      }
      if (finished) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    if (err) throw err;
  } finally {
    clientSignal.removeEventListener('abort', onClientAbort);
    controller.abort();
    await run.catch(() => {});
  }
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

/**
 * Resolve `nodeName` from kubeconfig and assert it carries a RAG
 * binding. Throws `TRPCError('BAD_REQUEST')` when the node isn't a
 * RAG node — every ragX procedure uses this up-front so callers get
 * a predictable error shape instead of an adapter-layer exception.
 */
function resolveRagNode(nodeName: string): { node: ClusterNode } {
  const cfg = kubecfg.loadConfig();
  const resolved = kubecfg.resolveNode(cfg, nodeName);
  if (!resolved.node.rag) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `node '${nodeName}' is not a RAG node`,
    });
  }
  return { node: resolved.node };
}

/**
 * Lazy-initialized Docker runtime backend shared by every composite
 * procedure. Instantiation is deferred until first use so
 * `router.ts`-at-load-time never fails on hosts without Docker — the
 * first `compositeApply` / `compositeDestroy` call is what triggers
 * the `createDockerBackend()` import + construction.
 *
 * Tests that need to inject a fake backend go through `composite-
 * apply.test.ts` (which calls `applyComposite` directly with a
 * synthetic `RuntimeBackend`). The router-level tests stay on the
 * dry-run path so they never touch this helper.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _compositeRuntime: import('./runtime/backend.js').RuntimeBackend | null = null;
async function getCompositeRuntime(): Promise<
  import('./runtime/backend.js').RuntimeBackend
> {
  if (_compositeRuntime) return _compositeRuntime;
  const { createDockerBackend } = await import('./runtime/docker/backend.js');
  _compositeRuntime = createDockerBackend();
  return _compositeRuntime;
}

/**
 * Planner tool descriptors the server always advertises, regardless of
 * what the caller (UI, CLI, MCP client) supplies via `input.tools`.
 * These are tools whose "reach" spans multiple individual procedures —
 * the LLM planner needs to know about them up-front so it can emit a
 * single-step plan that replaces a multi-step decomposition.
 *
 * Phase 6 scope: `llamactl.composite.apply`. A Composite manifest
 * bundles services, workloads, RAG nodes, and gateway registrations
 * into one atomic unit with an internal dependency DAG — the LLM
 * reaches for this when the operator describes a stack rather than a
 * single component. Dispatch routing is Phase 5's responsibility in
 * `ops-chat/dispatch.ts`; this registration layer never executes the
 * tool, only teaches the planner it exists.
 */
export const BUILT_IN_PLANNER_TOOLS: readonly PlannerToolDescriptor[] = [
  {
    name: 'llamactl.composite.apply',
    description:
      'Apply a Composite manifest that declares a full stack in one atomic unit — models + gateways + RAG nodes + supporting services (chroma, pgvector, and future database/nginx/redis backends) — with a dependency DAG and rollback on failure. PREFER this tool over multiple individual tool calls (llamactl.workload.apply + llamactl.rag.store + supporting-service setup) when the operator describes a multi-component setup (three or more interacting pieces). The manifest is a YAML string; the applier topologically orders components, spawns containers via Docker for runtime:"docker" services (external-runtime services are assumed up), wires RAG node endpoints from backing services, and registers everything atomically. For single-model or single-service asks, prefer the narrower individual tool instead.',
    inputSchema: {
      type: 'object',
      required: ['manifestYaml'],
      properties: {
        manifestYaml: {
          type: 'string',
          minLength: 1,
          description:
            'The full Composite YAML manifest (apiVersion: llamactl/v1, kind: Composite). Includes services, workloads, ragNodes, gateways, and optional dependencies edges inside `spec`.',
        },
        dryRun: {
          type: 'boolean',
          default: false,
          description:
            'When true, return the would-apply plan + topological order without hitting the backend. Use this on the first emission of the step so the operator can review the DAG before wet-run.',
        },
      },
    },
    tier: 'mutation-dry-run-safe',
  },
];

/**
 * Merge caller-supplied planner tools with the server-side built-ins.
 * Caller entries take precedence on name collision so an explicit
 * override from the UI keeps working if we ever need to redefine a
 * built-in description at call site. Built-ins not present in the
 * caller list are appended at the end so they appear last in the
 * prompt's AVAILABLE TOOLS block — the LLM still sees them, but
 * caller-supplied tools keep their prompt ordering.
 */
export function mergePlannerTools(
  callerTools: PlannerToolDescriptor[],
  builtins: readonly PlannerToolDescriptor[],
): PlannerToolDescriptor[] {
  const seen = new Set(callerTools.map((t) => t.name));
  const out: PlannerToolDescriptor[] = [...callerTools];
  for (const t of builtins) {
    if (seen.has(t.name)) continue;
    out.push(t);
    seen.add(t.name);
  }
  return out;
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

  nodeList: t.procedure.query(async () => {
    const cfg = kubecfg.loadConfig();
    const ctx = kubecfg.currentContext(cfg);
    const cluster = cfg.clusters.find((c) => c.name === ctx.cluster);
    const { resolveNodeKind } = await import('./config/schema.js');
    const { synthesizeProviderNodes } = await import('./config/provider-nodes.js');
    // Provider-kind virtual nodes derived from sirius-providers.yaml
    // for each gateway. Synthesized fresh on every read — no cache.
    const synthetic = synthesizeProviderNodes(cfg);
    const persisted = (cluster?.nodes ?? []).map((n) => ({
      ...n,
      effectiveKind: resolveNodeKind(n),
    }));
    const virtual = synthetic.map((n) => ({
      ...n,
      effectiveKind: 'provider' as const,
    }));
    return {
      context: ctx.name,
      cluster: ctx.cluster,
      defaultNode: ctx.defaultNode,
      nodes: [...persisted, ...virtual],
    };
  }),

  nodeTest: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.name);
      const { resolveNodeKind } = await import('./config/schema.js');
      const kind = resolveNodeKind(resolved.node);
      const node = resolved.node;

      // Gateway + provider kinds don't have nodeFacts (no llamactl
      // agent behind them). Probe via the OpenAI-compat adapter's
      // healthCheck — cheap `/v1/models` call that confirms the
      // upstream answers and, for provider kind, that at least one
      // model claims `owned_by === providerName`.
      if (kind === 'gateway' || kind === 'provider') {
        const { providerForNode } = await import('./providers/factory.js');
        try {
          const provider = providerForNode({ node, user: resolved.user, cfg });
          const health = await provider.healthCheck?.();
          if (!health) return { ok: true as const, facts: null };
          if (health.state === 'healthy' || health.state === 'degraded') {
            // For provider kind, also confirm the upstream actually
            // carries that provider's models — a gateway reporting
            // healthy doesn't prove the specific provider is alive.
            if (kind === 'provider' && provider.listModels) {
              try {
                const models = await provider.listModels();
                const binding = node.provider!;
                const hit = models.some(
                  (m) => (m as { owned_by?: string }).owned_by === binding.providerName,
                );
                if (!hit) {
                  return {
                    ok: false as const,
                    error: `provider '${binding.providerName}' not present in gateway's model catalog`,
                  };
                }
              } catch {
                // If listModels fails, fall back to the gateway's
                // health. Not ideal but not worth failing the probe.
              }
            }
            return { ok: true as const, facts: null };
          }
          return {
            ok: false as const,
            error: health.error ?? `state=${health.state}`,
          };
        } catch (err) {
          return { ok: false as const, error: (err as Error).message };
        }
      }

      const token = kubecfg.resolveToken(resolved.user);
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

  nodeSetDefault: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(({ input }) => {
      const cfgPath = kubecfg.defaultConfigPath();
      let cfg = kubecfg.loadConfig(cfgPath);
      cfg = kubecfg.setDefaultNode(cfg, input.name);
      kubecfg.saveConfig(cfg, cfgPath);
      const ctx = kubecfg.currentContext(cfg);
      return { ok: true as const, defaultNode: ctx.defaultNode };
    }),

  /**
   * Register a cloud-provider node. Unlike `nodeAdd` (which bootstraps
   * a remote agent via a bearer-token blob), this stores a pointer to
   * an external OpenAI-compatible API — the raw key stays out of
   * kubeconfig by living behind an env var or file path
   * (`$OPENAI_API_KEY`, `~/.llamactl/keys/openai`, …).
   */
  nodeAddCloud: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        provider: z.enum([
          'openai',
          'anthropic',
          'together',
          'groq',
          'mistral',
          'openai-compatible',
          'sirius',
          'embersynth',
        ]),
        baseUrl: z.url().optional(),
        // Optional: sirius-gateway / local dev endpoints may be
        // unauthenticated. When absent the adapter omits the
        // Authorization header.
        apiKeyRef: z.string().optional(),
        displayName: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { defaultCloudBinding, providerForCloudNode } = await import(
        './providers/factory.js'
      );
      const cfgPath = kubecfg.defaultConfigPath();
      let cfg = kubecfg.loadConfig(cfgPath);
      const ctx = kubecfg.currentContext(cfg);
      const binding = defaultCloudBinding(input.provider, input.apiKeyRef ?? '', {
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
      });
      // `defaultCloudBinding` persists apiKeyRef as an empty string
      // when the caller omitted it; drop the field entirely so the
      // stored node matches the "anonymous" semantics.
      if (!input.apiKeyRef) delete (binding as { apiKeyRef?: string }).apiKeyRef;
      if (!binding.baseUrl) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'baseUrl is required for openai-compatible provider',
        });
      }
      // Probe the binding — empty apiKeyRef or wrong URL fails here
      // rather than silently later.
      try {
        const provider = providerForCloudNode({
          name: input.name,
          endpoint: '',
          kind: 'gateway',
          cloud: binding,
        });
        const health = await provider.healthCheck?.();
        if (health && health.state === 'unhealthy') {
          throw new Error(health.error ?? 'cloud node health check failed');
        }
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `cloud node probe failed: ${(err as Error).message}`,
        });
      }
      cfg = kubecfg.upsertNode(cfg, ctx.cluster, {
        name: input.name,
        endpoint: '',
        kind: 'gateway',
        cloud: binding,
      });
      kubecfg.saveConfig(cfg, cfgPath);
      return { ok: true as const, name: input.name, baseUrl: binding.baseUrl };
    }),

  // ---- chat (Nova-typed) ---------------------------------------------

  /**
   * Non-streaming chat completion against a node's provider (cloud
   * adapter or the agent's `/v1` gateway). Returns the full
   * `UnifiedAiResponse` — identical shape whether the node is a
   * local agent, remote agent, or cloud provider.
   *
   * Streaming lives in `chatStream`.
   */
  chatComplete: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        request: z.looseObject({
          model: z.string(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            }),
          ),
          temperature: z.number().optional(),
          max_tokens: z.number().int().positive().optional(),
          providerOptions: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.node);
      if (resolved.node.endpoint === 'inproc://local') {
        // Local agent — short-circuit through core's openaiProxy.
        const { openaiProxy } = await import('@llamactl/core');
        const req = new Request('http://local/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input.request, stream: false }),
        });
        const res = await openaiProxy.proxyOpenAI(req);
        if (!res.ok) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `local chat ${res.status}`,
          });
        }
        return res.json();
      }
      const { providerForNode } = await import('./providers/factory.js');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = providerForNode({ node: resolved.node, user: resolved.user, cfg });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return provider.createResponse(input.request as any);
    }),

  /**
   * Streaming chat completion. Yields `UnifiedStreamEvent` values from
   * Nova — chunks, tool calls, errors, and a final `done` event —
   * bridged back through the dispatcher's subscription transport.
   */
  chatStream: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        request: z.looseObject({
          model: z.string(),
          messages: z.array(
            z.object({
              role: z.string(),
              content: z.union([z.string(), z.array(z.unknown()), z.null()]),
            }),
          ),
          temperature: z.number().optional(),
          max_tokens: z.number().int().positive().optional(),
          providerOptions: z.record(z.string(), z.unknown()).optional(),
        }),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.node);
      const { providerForNode } = await import('./providers/factory.js');
      // Local-inproc agent: same OpenAI-compat adapter, but pointed at
      // the in-process llama-server's HTTP endpoint (not the
      // sentinel). resolveEnv() gives us LLAMA_CPP_HOST/PORT.
      if (resolved.node.endpoint === 'inproc://local') {
        const { env: envMod } = await import('@llamactl/core');
        const { createOpenAICompatProvider } = await import('@nova/contracts');
        const rEnv = envMod.resolveEnv();
        const provider = createOpenAICompatProvider({
          name: 'local',
          baseUrl: `http://${rEnv.LLAMA_CPP_HOST}:${rEnv.LLAMA_CPP_PORT}/v1`,
          apiKey: 'local',
        });
        const stream = provider.streamResponse?.(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input.request as any,
          signal,
        );
        if (!stream) {
          yield { type: 'done' as const, finish_reason: 'stop' as const };
          return;
        }
        for await (const ev of stream) {
          if (signal?.aborted) break;
          yield ev;
        }
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const provider = providerForNode({ node: resolved.node, user: resolved.user, cfg });
      const stream = provider.streamResponse?.(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        input.request as any,
        signal,
      );
      if (!stream) {
        yield { type: 'done' as const, finish_reason: 'stop' as const };
        return;
      }
      for await (const ev of stream) {
        if (signal?.aborted) break;
        yield ev;
      }
    }),

  /**
   * List the models a node exposes — works for both agent and cloud
   * kinds via their respective `AiProvider.listModels()` impl. Used
   * by the aggregate `/v1/models` surface and the chat UI's model
   * picker.
   */
  nodeModels: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.name);
      const { resolveNodeKind } = await import('./config/schema.js');
      const kind = resolveNodeKind(resolved.node);
      if (kind === 'provider') {
        // Scope to the parent gateway's catalog, filtered by
        // `owned_by === providerName`. Sirius tags each model with
        // the provider that serves it, so this is the natural
        // narrowing for the chat UI's picker.
        const binding = resolved.node.provider!;
        const parent = cfg.clusters
          .find((c) => c.name === kubecfg.currentContext(cfg).cluster)
          ?.nodes.find((n) => n.name === binding.gateway);
        if (!parent) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `parent gateway '${binding.gateway}' not found`,
          });
        }
        const { providerForCloudNode } = await import('./providers/factory.js');
        const gatewayProvider = providerForCloudNode(parent);
        const all = (await gatewayProvider.listModels?.()) ?? [];
        const filtered = all.filter(
          (m) => (m as { owned_by?: string }).owned_by === binding.providerName,
        );
        return { node: input.name, kind, models: filtered };
      }
      if (kind === 'gateway') {
        const { providerForCloudNode } = await import('./providers/factory.js');
        const provider = providerForCloudNode(resolved.node);
        const models = (await provider.listModels?.()) ?? [];
        return { node: input.name, kind, models };
      }
      // Agent path — tRPC to the agent's nodeModels-via-openaiProxy.
      // Reuse the existing forwarding shape: local caller or pinned
      // client via clientForNode, then call openaiProxy's /v1/models
      // through the agent's /v1 HTTP surface. For simplicity today,
      // inline a call through the pinned-fetch path when remote,
      // and use the core listOpenAIModels directly when local.
      if (resolved.node.endpoint.startsWith('inproc://')) {
        const { openaiProxy } = await import('@llamactl/core');
        const res = openaiProxy.listOpenAIModels();
        return { node: input.name, kind, models: res.data };
      }
      // Remote agent: scrape its /v1/models endpoint via pinned fetch.
      const token = kubecfg.resolveToken(resolved.user);
      const { makePinnedFetch } = await import('./client/links.js');
      const pinned = makePinnedFetch(resolved.node);
      const r = await pinned(`${resolved.node.endpoint}/v1/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `remote /v1/models ${r.status}`,
        });
      }
      const body = (await r.json()) as { data?: unknown[] };
      return { node: input.name, kind, models: (body.data ?? []) as unknown[] };
    }),

  /**
   * Bundle everything a user needs to point an external OpenAI client
   * at a node's built-in gateway: base URL, bearer token, and (for
   * self-signed setups) the CA PEM + fingerprint. Sensitive — exposes
   * the raw token — so the renderer calls this on-demand when the user
   * opens the "OpenAI config" panel, not eagerly with `nodeList`.
   */
  nodeOpenAIConfig: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(({ input }) => {
      const cfg = kubecfg.loadConfig();
      const resolved = kubecfg.resolveNode(cfg, input.name);
      const token = kubecfg.resolveToken(resolved.user);
      return {
        node: input.name,
        baseUrl: `${resolved.node.endpoint}/v1`,
        apiKey: token,
        caCertPem: resolved.node.certificate ?? null,
        caFingerprint: resolved.node.certificateFingerprint ?? null,
      };
    }),

  /**
   * Broadcast-listen for llamactl agents on the local network.
   * Deduplicates against the current kubeconfig so already-registered
   * nodes are flagged and new candidates surface cleanly. Pure
   * discovery — it doesn't reveal or receive any bearer tokens, so
   * the user still has to paste a bootstrap blob to finish registration.
   */
  nodeDiscover: t.procedure
    .input(z.object({ timeoutMs: z.number().int().positive().max(10000).optional() }).optional())
    .query(async ({ input }) => {
      const { discoverAgents } = await import('./server/mdns.js');
      const found = await discoverAgents(input?.timeoutMs ?? 2500);
      const cfg = kubecfg.loadConfig();
      const cluster = cfg.clusters.find(
        (c) => c.name === kubecfg.currentContext(cfg).cluster,
      );
      const existingFingerprints = new Set(
        (cluster?.nodes ?? [])
          .map((n) => n.certificateFingerprint)
          .filter((fp): fp is string => typeof fp === 'string' && fp.length > 0),
      );
      return found.map((svc) => ({
        name: svc.name,
        nodeName: svc.nodeName,
        host: svc.host,
        port: svc.port,
        addresses: svc.addresses,
        version: svc.version,
        fingerprint: svc.fingerprint,
        url: `https://${svc.host}:${svc.port}`,
        alreadyRegistered: svc.fingerprint
          ? existingFingerprints.has(svc.fingerprint)
          : false,
      }));
    }),

  // ---- workload management --------------------------------------------

  /**
   * Resolved directory scanned for `ModelRun` manifests. Mirrors the
   * same cascade the store uses server-side (respects
   * `$LLAMACTL_WORKLOADS_DIR` override, then `$DEV_STORAGE`, then the
   * production `~/.llamactl` default). The UI reads this to render the
   * subheader "Declarative ModelRun manifests (<path>/*.yaml)" so
   * hermetic audits show the profile path instead of the user's real
   * home dir.
   */
  workloadsDir: t.procedure.query(() => ({
    dir: workloadStoreMod.defaultWorkloadsDir(),
  })),

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
        const workers = manifest.spec.workers ?? [];
        return {
          name: manifest.metadata.name,
          node: nodeName,
          rel: manifest.spec.target.value,
          phase,
          endpoint,
          status: manifest.status ?? null,
          /**
           * E.4 — multi-node summary. `workerCount` powers a badge on
           * the list row; `workerNodes` is handy for quick tooltips
           * without a second roundtrip. The full per-worker detail
           * (rpcHost, rpcPort, timeoutSeconds, extraArgs) lives in the
           * manifest and is fetched via `workloadDescribe` when the
           * operator opens the drawer. Keeps list response cheap.
           */
          workerCount: workers.length,
          workerNodes: workers.map((w) => w.node),
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
      // client on the remote path; local path wraps core directly).
      // `WorkloadClient` was widened from `NodeClient` precisely so this
      // callsite no longer needs an `as any` escape.
      const result = await workloadApplyMod.applyOne(manifest, (nodeName) =>
        clientForNode(cfg, nodeName),
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
  // ---- reconciler loop (auto-heal) ------------------------------------

  reconcilerStatus: t.procedure.query(() => reconcileLoopMod.reconcileLoopStatus()),

  reconcilerEvents: t.procedure.query(() => reconcileLoopMod.reconcileLoopEvents()),

  reconcilerStart: t.procedure
    .input(
      z.object({
        intervalSeconds: z.number().int().positive().min(5).max(600).optional(),
      }).optional(),
    )
    .mutation(({ input }) => {
      const cfg = kubecfg.loadConfig();
      reconcileLoopMod.startReconcileLoop({
        intervalMs: (input?.intervalSeconds ?? 10) * 1000,
        getClient: (nodeName) => clientForNode(cfg, nodeName),
      });
      return reconcileLoopMod.reconcileLoopStatus();
    }),

  reconcilerStop: t.procedure.mutation(() => {
    reconcileLoopMod.stopReconcileLoop();
    return reconcileLoopMod.reconcileLoopStatus();
  }),

  reconcilerKick: t.procedure.mutation(async () => {
    const cfg = kubecfg.loadConfig();
    await reconcileLoopMod.kickReconcileLoop((nodeName) =>
      clientForNode(cfg, nodeName),
    );
    return reconcileLoopMod.reconcileLoopStatus();
  }),

  // ---- bench scheduler ------------------------------------------------

  benchScheduleList: t.procedure.query(() => benchScheduleMod.loadSchedules()),

  benchScheduleAdd: t.procedure
    .input(
      z.object({
        id: z.string().min(1),
        node: z.string().min(1),
        rel: z.string().min(1),
        mode: z.enum(['auto', 'text', 'vision']).optional(),
        intervalSeconds: z.number().int().min(60).max(30 * 24 * 3600),
      }),
    )
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const existing = benchScheduleMod.loadSchedules(path);
      const next = benchScheduleMod.addSchedule(existing, {
        id: input.id,
        node: input.node,
        rel: input.rel,
        mode: input.mode ?? 'auto',
        intervalSeconds: input.intervalSeconds,
        enabled: true,
      });
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchScheduleRemove: t.procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const next = benchScheduleMod.removeSchedule(
        benchScheduleMod.loadSchedules(path),
        input.id,
      );
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchScheduleToggle: t.procedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(({ input }) => {
      const path = benchScheduleMod.defaultScheduleFilePath();
      const next = benchScheduleMod.updateSchedule(
        benchScheduleMod.loadSchedules(path),
        input.id,
        { enabled: input.enabled },
      );
      benchScheduleMod.saveSchedules(next, path);
      return next;
    }),

  benchSchedulerStatus: t.procedure.query(() =>
    benchScheduleLoopMod.benchSchedulerStatus(),
  ),

  benchSchedulerStart: t.procedure
    .input(
      z.object({
        tickIntervalSeconds: z.number().int().min(30).max(3600).optional(),
      }).optional(),
    )
    .mutation(({ input }) => {
      const cfg = kubecfg.loadConfig();
      benchScheduleLoopMod.startBenchScheduler({
        tickIntervalMs: (input?.tickIntervalSeconds ?? 60) * 1000,
        getClient: (nodeName) => clientForNode(cfg, nodeName),
      });
      return benchScheduleLoopMod.benchSchedulerStatus();
    }),

  benchSchedulerStop: t.procedure.mutation(() => {
    benchScheduleLoopMod.stopBenchScheduler();
    return benchScheduleLoopMod.benchSchedulerStatus();
  }),

  benchSchedulerKick: t.procedure.mutation(async () => {
    const cfg = kubecfg.loadConfig();
    await benchScheduleLoopMod.kickBenchScheduler((nodeName) =>
      clientForNode(cfg, nodeName),
    );
    return benchScheduleLoopMod.benchSchedulerStatus();
  }),

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

  // ---- infra package management -----------------------------------
  // Operates on the local agent's infra directory
  // (<DEV_STORAGE|~/.llamactl>/infra/). Central calls these via the
  // dispatcher to install/activate/remove llama-cpp / embersynth /
  // sirius on a specific node.

  infraList: t.procedure.query(() => infraLayoutMod.listInstalledInfra()),

  infraCurrent: t.procedure
    .input(z.object({ pkg: z.string().min(1) }))
    .query(({ input }) => infraLayoutMod.resolveCurrentVersion(input.pkg)),

  infraInstall: t.procedure
    .input(
      z.object({
        pkg: z.string().min(1),
        version: z.string().min(1),
        tarballUrl: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        activate: z.boolean().default(true),
        skipIfPresent: z.boolean().default(true),
      }),
    )
    .mutation(async ({ input }) => {
      return infraInstallMod.installInfraPackage({
        pkg: input.pkg,
        version: input.version,
        tarballUrl: input.tarballUrl,
        sha256: input.sha256,
        activate: input.activate,
        skipIfPresent: input.skipIfPresent,
      });
    }),

  infraActivate: t.procedure
    .input(z.object({ pkg: z.string().min(1), version: z.string().min(1) }))
    .mutation(({ input }) => {
      infraLayoutMod.activateInfraVersion(input.pkg, input.version);
      return { ok: true as const };
    }),

  infraUninstall: t.procedure
    .input(
      z.object({
        pkg: z.string().min(1),
        version: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      if (input.version) {
        const removed = infraLayoutMod.removeInfraVersion(input.pkg, input.version);
        return { ok: true as const, mode: 'version' as const, removed };
      }
      const removed = infraLayoutMod.removeInfraPackage(input.pkg);
      return { ok: true as const, mode: 'package' as const, removed };
    }),

  // Service lifecycle — drives launchd/systemd for supervised pkgs
  // (embersynth, sirius). llama-cpp is a binary, not a service, so
  // these procs return a clear error when called on a pkg without a
  // unit file on disk.
  infraServiceWriteUnit: t.procedure
    .input(
      z.object({
        pkg: z.string().min(1),
        env: z.record(z.string(), z.string()).default({}),
        args: z.array(z.string()).default([]),
      }),
    )
    .mutation(({ input }) => {
      const base = infraLayoutMod.defaultInfraDir();
      const logDir = infraServicesMod.defaultInfraLogsDir();
      const written = infraServicesMod.writeServiceUnit({
        pkg: input.pkg,
        infraBase: base,
        logDir,
        env: input.env,
        args: input.args,
      });
      return { ok: true as const, ...written };
    }),

  infraServiceLifecycle: t.procedure
    .input(
      z.object({
        pkg: z.string().min(1),
        action: z.enum(['start', 'stop', 'reload', 'status']),
      }),
    )
    .mutation(async ({ input }) => {
      const result = await infraServicesMod.runServiceLifecycle({
        pkg: input.pkg,
        action: input.action,
      });
      return {
        ok: result.code === 0,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        host: result.host,
        label: result.label,
      };
    }),

  catalogList: t.procedure
    .input(z.enum(['all', 'builtin', 'custom']).default('all'))
    .query(({ input }) => {
      // Mirror the CLI's `catalog status` signal: a row is "installed"
      // when the GGUF exists under $LLAMA_CPP_MODELS. The renderer uses
      // this to gate the Uninstall action, which is a no-op otherwise.
      const resolved = envMod.resolveEnv();
      return catalog.listCatalog(input).map((entry) => ({
        ...entry,
        installed: existsSync(join(resolved.LLAMA_CPP_MODELS, entry.rel)),
      }));
    }),

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
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<serverLogsMod.LogLineEvent>(
        signal as AbortSignal,
        (emit, sig) =>
          serverLogsMod.tailServerLog({
            lines: input?.lines,
            follow: input?.follow,
            signal: sig,
            onLine: emit,
          }),
      );
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
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<ServerStartEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await serverMod.startServer({
            target: input.target,
            extraArgs: input.extraArgs,
            timeoutSeconds: input.timeoutSeconds,
            skipTuned: input.skipTuned,
            signal: sig,
            onEvent: emit,
          });
          emit({ type: 'done', result });
        },
      );
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
    .query(({ input }) => {
      const plan = lmstudioMod.planImport({
        root: input?.root,
        link: input?.link,
      });
      // Surface the resolver's canonical default so the UI can show it
      // as a placeholder without recomputing paths client-side. Under
      // $LLAMACTL_TEST_PROFILE this re-roots to the profile-scoped dir.
      return { ...plan, defaultRoot: lmstudioMod.defaultLMStudioRoot() };
    }),

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

  /**
   * Preflight check for tensor-parallel apply. Fires before any
   * `rpcServerStart` call in `applyOne` → `startWorkers` and surfaces
   * a structured reason + build hint when `$LLAMA_CPP_BIN/rpc-server`
   * is missing (stock llama.cpp builds lack it — it only lands with
   * `-DGGML_RPC=ON`). Also available interactively as the
   * `llamactl agent rpc-doctor --node <name>` CLI.
   */
  rpcServerDoctor: t.procedure
    .input(z.object({}))
    .query(async () => rpcServerMod.checkRpcServerAvailable()),

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
    .subscription(async function* ({ input, signal }) {
      type RpcEvent =
        | rpcServerMod.RpcServerEvent
        | { type: 'done'; result: rpcServerMod.StartRpcServerResult };
      yield* bridgeEventStream<RpcEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await rpcServerMod.startRpcServer({
            ...input,
            signal: sig,
            onEvent: emit,
          });
          emit({ type: 'done', result });
        },
      );
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
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<CandidateStreamEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await candidateMod.candidateTest({
            repo: input.repo,
            file: input.file,
            profile: input.profile,
            signal: sig,
            onEvent: emit,
          });
          if ('error' in result) throw new Error(result.error);
          emit({ type: 'done-candidate-test', result });
        },
      );
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
    .subscription(async function* ({ input, signal }) {
      type TuneEvent =
        | bench.BenchEvent
        | { type: 'done-tune'; result: autotuneMod.MaybeTuneAfterPullResult };
      yield* bridgeEventStream<TuneEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await autotuneMod.maybeTuneAfterPull({
            rel: input.rel,
            wasMissing: input.wasMissing,
            signal: sig,
            onEvent: emit,
          });
          emit({ type: 'done-tune', result });
        },
      );
    }),

  pullFile: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().min(1),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<PullStreamEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await pull.pullRepoFile({
            repo: input.repo,
            file: input.file,
            signal: sig,
            onEvent: emit,
          });
          emit({ type: 'done', result });
        },
      );
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
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<BenchStreamEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await bench.benchPreset({
            target: input.target,
            mode: input.mode,
            signal: sig,
            onEvent: emit,
          });
          if ('error' in result) throw new Error(result.error);
          emit({ type: 'done-preset', result });
        },
      );
    }),

  benchVisionRun: t.procedure
    .input(z.object({ target: z.string().min(1) }))
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<BenchStreamEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await bench.benchVision({
            target: input.target,
            signal: sig,
            onEvent: emit,
          });
          if ('error' in result) throw new Error(result.error);
          emit({ type: 'done-vision', result });
        },
      );
    }),

  pullCandidate: t.procedure
    .input(
      z.object({
        repo: z.string().min(1),
        file: z.string().optional(),
        profile: z.string().optional(),
      }),
    )
    .subscription(async function* ({ input, signal }) {
      yield* bridgeEventStream<PullStreamEvent>(
        signal as AbortSignal,
        async (emit, sig) => {
          const result = await pull.pullCandidate({
            repo: input.repo,
            file: input.file,
            profile: input.profile,
            signal: sig,
            onEvent: emit,
          });
          if ('error' in result) throw new Error(result.error);
          emit({ type: 'done-candidate', result });
        },
      );
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

  /**
   * LLM-backed operator planner. Translates a natural-language goal
   * into a validated PlanSchema-shaped sequence of MCP tool calls.
   * Defaults to the canned stub executor so the Electron view renders
   * something useful out of the box; `mode: 'llm'` + a model + an
   * API key env name drives a real OpenAI-compat call. The renderer
   * seeds the tool catalog because the planner is deliberately
   * harness-agnostic.
   */
  operatorPlan: t.procedure
    .input(
      z.object({
        goal: z.string().min(1),
        context: z.string().optional(),
        mode: z.enum(['stub', 'llm']).optional(),
        model: z.string().optional(),
        baseUrl: z.string().optional(),
        apiKeyEnv: z.string().optional(),
        tools: z
          .array(
            z.object({
              name: z.string().min(1),
              description: z.string(),
              tier: z.enum(['read', 'mutation-dry-run-safe', 'mutation-destructive']),
            }),
          )
          .optional(),
        /**
         * Optional multi-turn history. Each entry captures a prior
         * operator-plan exchange: the user's goal/refinement, and a
         * short summary of the plan the assistant returned. The router
         * folds these into the `context` string before handing off to
         * `runPlanner`, so the underlying planner stays history-unaware
         * and continues to accept a single flat string.
         */
        history: z
          .array(
            z.object({
              role: z.enum(['user', 'assistant']),
              text: z.string(),
            }),
          )
          .optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const mode = input.mode ?? 'stub';
      let executor: PlannerExecutor = stubPlannerExecutor;
      if (mode === 'llm') {
        if (!input.model) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'model is required when mode=llm',
          });
        }
        const env = input.apiKeyEnv ?? 'OPENAI_API_KEY';
        const apiKey = process.env[env];
        if (!apiKey) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `env var ${env} is empty — set it or switch to mode=stub`,
          });
        }
        const provider = createOpenAICompatProvider({
          name: 'planner-llm',
          baseUrl: input.baseUrl ?? 'https://api.openai.com/v1',
          apiKey,
        });
        executor = createLlmExecutor({ provider, model: input.model });
      }
      const callerTools: PlannerToolDescriptor[] = (input.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: 'object' },
        tier: t.tier,
      }));
      // Merge caller-supplied tools with server-side built-ins (e.g.
      // composite.apply). Caller wins on name collision so UI-defined
      // descriptions can override defaults if ever needed. Phase 5's
      // ops-chat dispatch routes composite.apply plan steps to the
      // `compositeApply` tRPC procedure — this layer only teaches the
      // planner that the tool exists and when to prefer it.
      const plannerTools = mergePlannerTools(callerTools, BUILT_IN_PLANNER_TOOLS);

      // Fold history into the context string so the planner sees the
      // ongoing conversation. Keep the formatting deterministic — one
      // line per role, trimmed — so stub mode still produces stable
      // plans and the LLM executor gets a clean chat transcript.
      const history = input.history ?? [];
      const transcript = history
        .map((turn) => `${turn.role}: ${turn.text.trim()}`)
        .filter((line) => line.length > `user:`.length)
        .join('\n');
      const userContext = input.context?.trim() ?? '';
      const mergedContext = [transcript, userContext].filter((s) => s.length > 0).join('\n\n');

      const result = await runPlanner({
        goal: input.goal,
        context: mergedContext,
        tools: plannerTools,
        executor,
        allowlist: DEFAULT_ALLOWLIST,
      });
      return result;
    }),

  /**
   * Cost dashboard — snapshot.
   *
   * Aggregates the local `~/.llamactl/usage/*.jsonl` corpus into the
   * same per-provider / per-model rollup the `nova.ops.cost.snapshot`
   * MCP tool produces, but over direct function call — no MCP hop.
   * The Electron dashboard polls this on a user-selected window.
   */
  costSnapshot: t.procedure
    .input(
      z
        .object({
          days: z.number().int().positive().max(90).default(7),
        })
        .default({ days: 7 }),
    )
    .query(async ({ input }) => {
      return computeCostSnapshot({ days: input.days });
    }),

  /**
   * Cost dashboard — guardian status.
   *
   * Loads the cost-guardian YAML config (defaults if absent), runs one
   * snapshot for daily (1-day) + weekly (7-day) windows, and asks the
   * pure decision function what tier the current spend crosses. Never
   * mutates — the dashboard reads this to show the gauge + tier badge.
   */
  costGuardianStatus: t.procedure.query(async () => {
    const configPath = defaultCostGuardianConfigPath();
    const config = existsSync(configPath)
      ? loadCostGuardianConfig(configPath)
      : emptyCostGuardianConfig();
    const daily = computeCostSnapshot({ days: 1 });
    const weekly = computeCostSnapshot({ days: 7 });
    const decision = decideGuardianAction({
      config,
      daily: { snapshot: daily },
      weekly: { snapshot: weekly },
    });
    return {
      config: {
        budget: config.budget,
        thresholds: config.thresholds,
        hasWebhook: Boolean(config.webhook_url),
        autoForcePrivate: config.auto_force_private,
        autoDeregister: config.auto_deregister,
      },
      decision,
      daily,
      weekly,
    };
  }),

  /**
   * Cost dashboard — journal tail.
   *
   * Reads the cost-guardian JSONL journal and returns the last `limit`
   * entries (newest first). Empty array when the journal file doesn't
   * exist yet — the dashboard shows a "no ticks recorded" empty state
   * rather than erroring.
   */
  costJournalTail: t.procedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(50),
        })
        .default({ limit: 50 }),
    )
    .query(async ({ input }) => {
      const path = defaultCostJournalPath();
      if (!existsSync(path)) return { entries: [] as CostJournalEntry[], path };
      const body = readFileSync(path, 'utf8');
      const lines = body.split('\n').filter((l) => l.trim().length > 0);
      const entries: CostJournalEntry[] = [];
      for (const l of lines.slice(-input.limit).reverse()) {
        try {
          entries.push(JSON.parse(l) as CostJournalEntry);
        } catch {
          // skip malformed
        }
      }
      return { entries, path };
    }),

  /**
   * K.6 — Save a pipeline as an MCP tool stub.
   *
   * Writes a JSON file to `~/.llamactl/mcp/pipelines/<slug>.json`
   * (override via `LLAMACTL_MCP_PIPELINES_DIR`). The stub records the
   * pipeline's stages verbatim; `@llamactl/mcp` picks these up at
   * boot and mounts them as pre-registered tools named
   * `llamactl.pipeline.<slug>` that take a single `input` string.
   *
   * Purely declarative — the mcp server interprets the file, llamactl
   * here only persists it.
   */
  pipelineExportMcp: t.procedure
    .input(
      z.object({
        name: z
          .string()
          .min(1)
          .max(80)
          .describe('Human-friendly pipeline name; slugified for the file basename.'),
        description: z
          .string()
          .max(500)
          .optional()
          .describe('Short description surfaced to MCP clients.'),
        stages: z
          .array(
            z.object({
              node: z.string().min(1),
              model: z.string().min(1),
              systemPrompt: z.string().default(''),
              capabilities: z.array(z.string()).default([]),
            }),
          )
          .min(1, 'pipeline must have at least one stage'),
        overwrite: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const slug =
        input.name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || `pipeline-${Date.now().toString(36)}`;
      // Cascade: override > DEV_STORAGE (honours hermetic audits and
      // the resolver's test-profile re-root seeded in Electron main)
      // > production default under the operator's homedir.
      const devStorage = process.env.DEV_STORAGE?.trim();
      const baseDir =
        process.env.LLAMACTL_MCP_PIPELINES_DIR?.trim() ||
        (devStorage
          ? join(devStorage, 'mcp', 'pipelines')
          : join(homedir(), '.llamactl', 'mcp', 'pipelines'));
      const outPath = join(baseDir, `${slug}.json`);
      if (!input.overwrite && existsSync(outPath)) {
        return {
          ok: false as const,
          path: outPath,
          slug,
          reason: 'exists',
          message: `${outPath} already exists. Pass overwrite:true to replace.`,
        };
      }
      const stub = {
        apiVersion: 'llamactl/v1' as const,
        kind: 'PipelineTool' as const,
        name: `llamactl.pipeline.${slug}`,
        title: input.name,
        description:
          input.description ??
          `Multi-stage pipeline with ${input.stages.length} stage${input.stages.length === 1 ? '' : 's'}.`,
        inputSchema: {
          type: 'object',
          properties: {
            input: { type: 'string', description: 'Initial user content' },
          },
          required: ['input'],
        },
        stages: input.stages,
      };
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
      return {
        ok: true as const,
        path: outPath,
        slug,
        toolName: stub.name,
        stageCount: input.stages.length,
      };
    }),

  /**
   * N.4 — Ops Chat tool dispatch.
   *
   * Takes an MCP-style tool name + arguments and runs the equivalent
   * tRPC procedure via `createCaller` (in-proc, no HTTP). Every call
   * appends one audit entry to `~/.llamactl/ops-chat/audit.jsonl`
   * (override via `LLAMACTL_OPS_CHAT_AUDIT`). Supported tools are
   * enumerated in `KNOWN_OPS_CHAT_TOOLS`; anything else returns a
   * structured `unknown_tool` error without throwing.
   */
  opsChatTools: t.procedure.query(() => ({
    tools: KNOWN_OPS_CHAT_TOOLS,
  })),

  operatorRunTool: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        arguments: z.record(z.string(), z.unknown()).default({}),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const caller = router.createCaller({});
      const dispatched = await dispatchOpsChatTool(caller, {
        name: input.name,
        arguments: input.arguments,
        dryRun: input.dryRun,
      });
      const entry: OpsChatAuditEntry = {
        ts: new Date().toISOString(),
        tool: input.name,
        dryRun: input.dryRun,
        argumentsHash: hashArguments(input.arguments),
        ok: dispatched.ok,
        durationMs: dispatched.durationMs,
        ...(dispatched.ok
          ? {}
          : {
              errorCode: dispatched.error?.code ?? 'dispatch_error',
              errorMessage: dispatched.error?.message ?? '(no message)',
            }),
      };
      appendOpsChatAudit(entry);
      return dispatched;
    }),

  opsChatAuditTail: t.procedure
    .input(
      z
        .object({
          limit: z.number().int().positive().max(500).default(100),
        })
        .default({ limit: 100 }),
    )
    .query(({ input }) => readOpsChatAudit({ limit: input.limit })),

  // ---- RAG (retrieval) --------------------------------------------------
  //
  // Each procedure opens a RetrievalProvider per call and closes it in
  // `finally`. Pooling is a follow-up (see rag-nodes.md Phase 4). The
  // adapter factory dispatches on `node.rag.provider`; nodes without
  // `kind: 'rag'` fail fast with BAD_REQUEST.

  ragSearch: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        query: z.string().min(1),
        topK: z.number().int().positive().max(100).default(10),
        filter: z.record(z.string(), z.unknown()).optional(),
        collection: z.string().optional(),
      }),
    )
    .query(async ({ input }) => {
      const { node } = resolveRagNode(input.node);
      const { createRagAdapter } = await import('./rag/index.js');
      const adapter = await createRagAdapter(node);
      try {
        return await adapter.search({
          query: input.query,
          topK: input.topK,
          filter: input.filter,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragStore: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        documents: z
          .array(
            z.object({
              id: z.string().min(1),
              content: z.string(),
              metadata: z.record(z.string(), z.unknown()).optional(),
              vector: z.array(z.number()).optional(),
            }),
          )
          .min(1),
        collection: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { node } = resolveRagNode(input.node);
      const { createRagAdapter } = await import('./rag/index.js');
      const adapter = await createRagAdapter(node);
      try {
        return await adapter.store({
          documents: input.documents,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragDelete: t.procedure
    .input(
      z.object({
        node: z.string().min(1),
        ids: z.array(z.string().min(1)).min(1),
        collection: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { node } = resolveRagNode(input.node);
      const { createRagAdapter } = await import('./rag/index.js');
      const adapter = await createRagAdapter(node);
      try {
        return await adapter.delete({
          ids: input.ids,
          collection: input.collection,
        });
      } finally {
        await adapter.close();
      }
    }),

  ragListCollections: t.procedure
    .input(z.object({ node: z.string().min(1) }))
    .query(async ({ input }) => {
      const { node } = resolveRagNode(input.node);
      const { createRagAdapter } = await import('./rag/index.js');
      const adapter = await createRagAdapter(node);
      try {
        return await adapter.listCollections();
      } finally {
        await adapter.close();
      }
    }),

  // ---- Composite (multi-component apply) --------------------------------
  //
  // Phase 5 of composite-infra.md — tRPC surface for the composite
  // applier. Each procedure is a thin caller shim over `applyComposite`
  // / `destroyComposite` / the `store.ts` YAML helpers, mirroring the
  // MCP `llamactl.composite.*` tools 1:1 so ops-chat + external MCP
  // clients + the Electron module share one code path.

  compositeApply: t.procedure
    .input(
      z.object({
        manifestYaml: z.string().min(1),
        dryRun: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { parseComposite } = await import('./composite/store.js');
      const { topologicalOrder, impliedEdges } = await import(
        './composite/dag.js'
      );
      let manifest;
      try {
        manifest = parseComposite(input.manifestYaml);
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `invalid composite manifest: ${(err as Error).message}`,
        });
      }
      if (input.dryRun) {
        const order = topologicalOrder(manifest.spec);
        const implied = impliedEdges(manifest.spec);
        return {
          dryRun: true as const,
          manifest,
          order,
          impliedEdges: implied,
        };
      }
      // Wet run — drive the applier through the shared backend and
      // publish every event onto the in-memory bus so concurrent
      // `compositeStatus` subscribers can stream live progress.
      const { applyComposite } = await import('./composite/apply.js');
      const { compositeEvents } = await import('./composite/event-bus.js');
      const backend = await getCompositeRuntime();
      const name = manifest.metadata.name;
      compositeEvents.startRun(name);
      try {
        const result = await applyComposite({
          manifest,
          backend,
          getWorkloadClient: (nodeName) =>
            clientForNode(kubecfg.loadConfig(), nodeName) as workloadApplyMod.WorkloadClient,
          onEvent: (e) => compositeEvents.emit(name, e),
        });
        return { dryRun: false as const, ...result };
      } finally {
        // Even on throw we want the bus to flip the run to `done` so
        // subscribers drain cleanly and the retention timer starts.
        compositeEvents.endRun(name);
      }
    }),

  compositeDestroy: t.procedure
    .input(
      z.object({
        name: z.string().min(1),
        dryRun: z.boolean().default(false),
        purgeVolumes: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const { loadComposite, deleteComposite } = await import(
        './composite/store.js'
      );
      const { topologicalOrder, reverseOrder } = await import(
        './composite/dag.js'
      );
      const manifest = loadComposite(input.name);
      if (!manifest) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `composite '${input.name}' not found`,
        });
      }
      if (input.dryRun) {
        const wouldRemove = reverseOrder(topologicalOrder(manifest.spec));
        return {
          dryRun: true as const,
          name: input.name,
          wouldRemove,
          wouldPurgeVolumes: input.purgeVolumes,
        };
      }
      const { destroyComposite } = await import('./composite/apply.js');
      const backend = await getCompositeRuntime();
      const result = await destroyComposite({
        manifest,
        backend,
        getWorkloadClient: (nodeName) =>
          clientForNode(kubecfg.loadConfig(), nodeName) as workloadApplyMod.WorkloadClient,
        purgeVolumes: input.purgeVolumes,
      });
      // Best-effort cleanup of the on-disk YAML. Destroy is the only
      // place the file gets removed; apply-failures leave a status-
      // tagged record so operators can investigate.
      deleteComposite(input.name);
      return {
        dryRun: false as const,
        ok: result.ok,
        removed: result.removed,
        errors: result.errors,
        purgedVolumes: input.purgeVolumes,
      };
    }),

  compositeList: t.procedure.query(async () => {
    const { listComposites } = await import('./composite/store.js');
    return listComposites();
  }),

  compositeGet: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .query(async ({ input }) => {
      const { loadComposite } = await import('./composite/store.js');
      return loadComposite(input.name);
    }),

  /**
   * Subscription variant of compositeGet. Prefers the live in-memory
   * bus when a `compositeApply` is in-flight for this name: late
   * subscribers receive the replayed buffer + any future events up to
   * and including `done`. When no run is active (or the run has aged
   * out of the retention window), we fall back to synthesizing a
   * one-shot stream from the persisted `status` field on the YAML.
   */
  compositeStatus: t.procedure
    .input(z.object({ name: z.string().min(1) }))
    .subscription(({ input, signal }) => {
      const clientSignal = signal ?? new AbortController().signal;
      return bridgeEventStream<
        import('./composite/types.js').CompositeApplyEvent
      >(clientSignal, async (emit) => {
        const { compositeEvents } = await import('./composite/event-bus.js');
        const runBus = compositeEvents.currentRun(input.name);
        if (runBus && !runBus.done) {
          // Live path — replay the buffer + attach for future events.
          // The returned Promise resolves on the terminal `done` event
          // or when the client disconnects, whichever lands first.
          return new Promise<void>((resolve) => {
            let settled = false;
            const finish = (): void => {
              if (settled) return;
              settled = true;
              unsub();
              resolve();
            };
            const unsub = compositeEvents.subscribe(input.name, (e) => {
              emit(e);
              if (e.type === 'done') {
                finish();
              }
            });
            clientSignal.addEventListener('abort', finish);
          });
        }
        // Fall back to the persisted-status synthesis path.
        const { loadComposite } = await import('./composite/store.js');
        const manifest = loadComposite(input.name);
        if (!manifest) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `composite '${input.name}' not found`,
          });
        }
        const status = manifest.status;
        if (status) {
          emit({ type: 'phase', phase: status.phase });
          for (const c of status.components) {
            emit({ type: 'component-start', ref: c.ref });
            if (c.state === 'Ready') {
              emit({
                type: 'component-ready',
                ref: c.ref,
                ...(c.message !== undefined && { message: c.message }),
              });
            } else if (c.state === 'Failed') {
              emit({
                type: 'component-failed',
                ref: c.ref,
                message: c.message ?? 'component failed',
              });
            }
          }
          emit({
            type: 'done',
            ok: status.phase === 'Ready',
          });
        } else {
          // Manifest exists but was never applied — emit a pending
          // phase so the UI can render an empty state cleanly.
          emit({ type: 'phase', phase: 'Pending' });
          emit({ type: 'done', ok: false });
        }
      });
    }),
});

export type AppRouter = typeof router;
