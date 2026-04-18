import { initTRPC, TRPCError } from '@trpc/server';
import { createTRPCClient } from '@trpc/client';
import { z } from 'zod';
import * as kubecfg from './config/kubeconfig.js';
import { decodeBootstrap } from './config/agent-config.js';
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
    // Decorate each node with its effective kind so the UI can render
    // agent vs cloud badges without reimplementing the fallback rule.
    const nodes = (cluster?.nodes ?? []).map((n) => ({
      ...n,
      effectiveKind: resolveNodeKind(n),
    }));
    return {
      context: ctx.name,
      cluster: ctx.cluster,
      defaultNode: ctx.defaultNode,
      nodes,
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
          kind: 'cloud',
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
        kind: 'cloud',
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
        request: z.object({
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
        }).passthrough(),
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
      const provider = providerForNode({ node: resolved.node, user: resolved.user });
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
        request: z.object({
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
        }).passthrough(),
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
        const { createOpenAICompatProvider } = await import('@llamactl/nova');
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
      const provider = providerForNode({ node: resolved.node, user: resolved.user });
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
      if (kind === 'cloud') {
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
});

export type AppRouter = typeof router;
