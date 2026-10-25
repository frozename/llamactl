import type { AgentWorkerRpc, AgentWorkerRpcRelay } from "@llamactl/core/config/agent-config";

import { inferenceRpc, openaiProxy } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { migrateLegacySingletonRuntime } from "@llamactl/core/workloadRuntime";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { join } from "node:path";

import type { ModelRun } from "../workload/schema.js";

import {
  createWorkerRpcHost,
  DEFAULT_SHARED_MAX_ACTIVE_PER_OWNER,
  type InferenceRpcContext,
  publishWorkerRpcHost,
  type WorkerRpcHostOptions,
} from "../inference/procedures.js";
import { dispatchProxyRequest, publishUnifiedPeerSnapshots } from "../proxy/create-proxy.js";
import { type AgentRouterContext, router as appRouter } from "../router.js";
import { handleFleetSnapshotRoute } from "../routes/fleet.js";
import { existsSync, readFileSync } from "../safe-fs.js";
import { startSearchIngest, stopSearchIngest } from "../search/ingest/lifecycle.js";
import {
  type ClientWebSocketConstructor,
  createTunnelClient,
  createTunnelRouterHandler,
  createTunnelServer,
  createTunnelSubscriptionHandler,
  type TunnelClient,
  type TunnelReq,
  type TunnelServer,
  type TunnelState,
} from "../tunnel/index.js";
import { isInferenceRpcProcedure } from "../tunnel/messages.js";
import { listWorkloads, saveWorkload } from "../workload/store.js";
import { handleAgentRollback, handleAgentUpdate } from "./agent-update.js";
import { type ArtifactsHandlerOptions, handleArtifact } from "./artifacts.js";
import {
  claimsForServiceCredential,
  createServiceTokenVerifier,
  extractBearer,
  namedBearerFor,
  type NamedBearerToken,
  relayPrincipalOf,
  SERVICE_TOKEN_HEADER,
  SERVICE_TOKEN_MAX_LENGTH,
  type ServiceCredentialBinding,
  unauthorizedResponse,
  verifyBearer,
} from "./auth.js";
import { handleInstallScript, type InstallScriptHandlerOptions } from "./install-script.js";
import { publishAgentMdns, type PublishedAgent } from "./mdns.js";
import {
  agentInfo,
  llamaServerUp,
  registry as metricsRegistry,
  openaiPathBucket,
  openaiRequestDurationSeconds,
  openaiRequestsTotal,
  openaiUpstreamErrorsTotal,
  statusClass,
} from "./metrics.js";
import { startPeerSnapshotPoller } from "./peer-snapshot-poller.js";
import { handleRagChatCompletions } from "./rag-chat-endpoint.js";
import { handleRegister, type RegisterHandlerOptions } from "./register.js";
import { loadCert } from "./tls.js";
import { handleTunnelRelay } from "./tunnel-relay.js";

export interface StartAgentOptions {
  bindHost?: string; // default '127.0.0.1'
  port?: number; // default 0 (let OS pick)
  endpoint?: string; // default '/trpc'
  tokenHash: string; // SHA-256 hex of the expected bearer token
  /**
   * Named operator bearer tokens (#218), read on every request, so an
   * added or revoked token applies without a restart. Each authenticates
   * the authed API routes exactly as `tokenHash` does; the tunnel relay,
   * self-update and rollback stay primary-only.
   */
  bearerTokens?: () => readonly NamedBearerToken[] | undefined;
  noAuth?: boolean;
  tls?: { certPath: string; keyPath: string }; // omit for plain HTTP (test-only)
  onRequest?: (url: URL) => void;
  /**
   * Labels attached to `llamactl_agent_info`. Defaults to a best-
   * effort guess from env; callers can override for deterministic
   * test output.
   */
  nodeName?: string;
  version?: string;
  /**
   * Advertise this agent over mDNS so other LAN nodes can discover
   * it. Defaults to true on a TLS-enabled agent (production), false
   * otherwise (hermetic test agents shouldn't pollute the network).
   */
  advertiseMdns?: boolean;
  /**
   * Poll cluster peers' /v1/fleet/snapshot and publish them to the openaiProxy
   * so peer models route through this proxy (with prefix-cache). Off by default
   * — only the production CLI (`agent serve`) enables it; hermetic test agents
   * must not make network calls to real peers.
   */
  peerSnapshotPoll?: boolean;
  peerSnapshotPollIntervalMs?: number;
  /**
   * Override paths for the /register handler. Production leaves this
   * unset so the handler uses ~/.llamactl/bootstrap-tokens and
   * ~/.llamactl/config; tests inject tempdirs.
   */
  registerOptions?: RegisterHandlerOptions;
  /** Tempdir injection for /install-agent.sh in tests. */
  installScriptOptions?: InstallScriptHandlerOptions;
  /** Tempdir injection for /artifacts/* in tests. */
  artifactsOptions?: ArtifactsHandlerOptions;
  /**
   * When set, agent mounts the reverse-tunnel upgrade handler at
   * `/tunnel` and the HTTP relay at `/tunnel-relay/<nodeName>`.
   * Agents that dial in use this agent as their central.
   * See packages/remote/src/tunnel/README or radiant-converging-knuth.md §I.3.
   */
  tunnelCentral?: {
    /** SHA-256 hex of the bearer tunnel clients present in their
     *  first hello frame. Distinct from tokenHash — tunnel bearers
     *  are a separate credential. */
    expectedBearerHash: string;
    /**
     * Central's relay-only credentials (P4.1), agent.yaml's
     * `workerRpcRelay` block, read on every relay request. Each admits
     * only relaying the worker-RPC procedures to nodes; the operator bearer
     * keeps relaying everything, as before.
     */
    workerRpcRelay?: () => AgentWorkerRpcRelay | undefined;
    onNodeConnect?: (nodeName: string) => void;
    onNodeDisconnect?: (nodeName: string, reason: string) => void;
  };
  /**
   * Override the JSONL audit journal path for tunnel events
   * (connect / disconnect / relay-call / relay-error / unauthorized
   * / replaced). Resolves to
   * `defaultTunnelJournalPath()` inside journal.ts when undefined
   * (honors `$LLAMACTL_TUNNEL_JOURNAL` and `$DEV_STORAGE`). Pass
   * through on both sides: `createTunnelServer` gets it for the WS
   * events, `handleTunnelRelay` gets it for the HTTP bridge events.
   */
  tunnelJournalPath?: string;
  /**
   * Override the JSONL fleet journal that `GET /v1/fleet/snapshot`
   * reads. Resolves to `defaultFleetJournalPath()` inside the route
   * when undefined (honors `$DEV_STORAGE`). Set this so the agent
   * serves the SAME journal the fleet-supervisor writes — otherwise,
   * when the agent and supervisor processes have different
   * `$DEV_STORAGE`, the route resolves a different (stale) default
   * path than the supervisor writes to. `agent serve --fleet-journal`
   * threads this through.
   */
  fleetJournalPath?: string;
  /**
   * When set, agent dials a central's /tunnel endpoint and bridges
   * inbound req frames to its own tRPC router. Use alongside or
   * independently of tunnelCentral — a given agent can be both
   * central (for NAT'd nodes that dial in) and a dialing node
   * (relative to a different central) if the fleet topology wants it.
   */
  tunnelDial?: {
    url: string;
    bearer: string;
    nodeName: string;
    /** Optional observer for connecting|ready|disconnected|stopped. */
    onStateChange?: (state: TunnelState) => void;
    /** Pass through to createTunnelClient; omit for production defaults. */
    initialAttemptTimeoutMs?: number;
    /** Test-only WebSocket constructor override. */
    WebSocketCtor?: ClientWebSocketConstructor;
  };
  /**
   * Serve the InferenceRpcV1 worker (P4.1). `workerId` is the node's
   * kubeconfig name, which the worker's deployment ids embed.
   * `settings` (agent.yaml's `workerRpc` block) is read on every RPC
   * call: a service credential is accepted, on the worker-RPC procedures only,
   * when it matches a binding, and the versions it lists that this build
   * speaks are advertised. Absent or listing no version, the RPC is not
   * advertised, as before. `stop()` drains active attempts for up to
   * `drainTimeoutMs` (default 15 s), then cancels the rest.
   */
  workerRpc?: {
    workerId: string;
    settings: () => AgentWorkerRpc | undefined;
    drainTimeoutMs?: number;
    /** Stands in for the engines, so a test can hold a backend's unwind after a cancel. */
    backends?: WorkerRpcHostOptions["backends"];
  };
}

export interface RunningAgent {
  url: string; // e.g. https://127.0.0.1:7843
  port: number;
  fingerprint: string | null;
  stop: () => Promise<void>;
  handleRequest?: (req: Request, address?: ClientAddress | null) => Promise<Response>;
  /** Present only when StartAgentOptions.tunnelCentral was set. */
  tunnelServer?: TunnelServer;
  /** Present only when StartAgentOptions.tunnelDial was set. */
  tunnelClient?: TunnelClient;
}

function synthesizeTransientWorkload(workloadName: string, statePath: string): void {
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as {
      rel?: string;
      extraArgs?: string[];
      host?: string;
      port?: string | number;
      binary?: string;
    };
    if (typeof parsed.rel !== "string") return;
    const transient: ModelRun = {
      apiVersion: "llamactl/v1",
      kind: "ModelRun",
      metadata: { name: workloadName, labels: {}, annotations: {} },
      spec: {
        node: "local",
        enabled: true,
        target: { kind: "rel", value: parsed.rel },
        extraArgs: Array.isArray(parsed.extraArgs) ? parsed.extraArgs : [],
        workers: [],
        restartPolicy: "Never",
        timeoutSeconds: 60,
        ...(typeof parsed.host === "string" || typeof parsed.port === "number"
          ? {
              endpoint: {
                ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
                ...(typeof parsed.port === "number" ? { port: parsed.port } : {}),
              },
            }
          : {}),
        ...(typeof parsed.binary === "string" ? { binary: parsed.binary } : {}),
        gateway: false,
        allowExternalBind: false,
      },
    };
    saveWorkload(transient);
  } catch {
    // Best effort only; the migrated runtime files are the source of truth.
  }
}

interface ClientAddress {
  address: string;
  port?: number;
  family?: string;
}

function formatClientAddress(address: ClientAddress | null | undefined): string {
  if (!address) return "unknown";
  return typeof address.port === "number"
    ? `${address.address}:${String(address.port)}`
    : address.address;
}

function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "localhost" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

export function runStartupMigration(): void {
  try {
    const resolved = resolveEnv();
    const migration = migrateLegacySingletonRuntime(
      resolved,
      listWorkloads().map((w) => ({
        metadata: { name: w.metadata.name },
        spec: {
          node: w.spec.node,
          target: w.spec.target,
          ...(w.spec.endpoint !== undefined
            ? {
                endpoint: {
                  ...(w.spec.endpoint.host !== undefined ? { host: w.spec.endpoint.host } : {}),
                  ...(w.spec.endpoint.port !== undefined ? { port: w.spec.endpoint.port } : {}),
                },
              }
            : {}),
        },
      })),
    );
    if (migration.kind === "migrated") {
      process.stderr.write(
        `[migration] re-homed legacy runtime under workload '${migration.workload}'\n`,
      );
    } else if (migration.kind === "synthesized") {
      process.stderr.write(
        `[migration] no manifest matched legacy state; synthesized '${migration.workload}'\n`,
      );
      synthesizeTransientWorkload(
        migration.workload,
        join(resolved.LOCAL_AI_RUNTIME_DIR, "workloads", migration.workload, "llama-server.state"),
      );
    }
  } catch {
    // Best effort only. If the legacy runtime path is unavailable or
    // unwritable, the agent still needs to start and serve the current state.
  }
}

interface NoAuthGate {
  allowNoAuth(pathname: string, address: ClientAddress | null): boolean;
  logUnauthenticatedNoAuthRequest(req: Request, address: ClientAddress | null): void;
}

function makeNoAuthGate(noAuth: boolean, bindHost: string): NoAuthGate {
  let unauthenticatedNoAuthRequestCount = 0;
  return {
    allowNoAuth(pathname: string, address: ClientAddress | null): boolean {
      return (
        noAuth &&
        pathname.startsWith("/v1/") &&
        isLoopbackAddress(bindHost) &&
        isLoopbackAddress(address?.address)
      );
    },
    logUnauthenticatedNoAuthRequest(req: Request, address: ClientAddress | null): void {
      if (!noAuth || extractBearer(req)) return;
      unauthenticatedNoAuthRequestCount += 1;
      if ((unauthenticatedNoAuthRequestCount - 1) % 100 !== 0) return;
      process.stderr.write(
        `[agent] WARNING: serving unauthenticated request from ${formatClientAddress(address)}: ${req.method} ${new URL(req.url).pathname}\n`,
      );
    },
  };
}

/**
 * Run the shared bearer-auth gate for a route: no-auth-eligible
 * requests are logged and admitted; everything else must carry a
 * valid bearer — the primary one or one of the named tokens. Returns
 * the 401 response when the request must be rejected, null when it
 * may proceed.
 */
function authGateReject(
  req: Request,
  pathname: string,
  address: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
): Response | null {
  if (gate.allowNoAuth(pathname, address)) {
    gate.logUnauthenticatedNoAuthRequest(req, address);
    return null;
  }
  if (verifyBearer(req, opts.tokenHash)) return null;
  if (namedBearerFor(extractBearer(req), opts.bearerTokens?.() ?? []) !== null) return null;
  return unauthorizedResponse();
}

async function handleOpenAIRoute(
  req: Request,
  url: URL,
  address: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
): Promise<Response> {
  const denied = authGateReject(req, url.pathname, address, opts, gate);
  if (denied) return denied;
  const pathLabel = openaiPathBucket(url.pathname);
  const endTimer = openaiRequestDurationSeconds.startTimer({ path: pathLabel });
  let status = 0;
  try {
    if (req.method === "GET" && url.pathname === "/v1/models") {
      const data = openaiProxy.listOpenAIModels().data;
      const models = { object: "list" as const, data };
      llamaServerUp.set(data.length > 0 ? 1 : 0);
      status = 200;
      return Response.json(models);
    }
    const res = await dispatchProxyRequest(req);
    status = res.status;
    if (status === 502) openaiUpstreamErrorsTotal.inc();
    return res;
  } finally {
    endTimer();
    openaiRequestsTotal.inc({ path: pathLabel, status_class: statusClass(status) });
  }
}

interface AgentFetchServer {
  requestIP?: (req: Request) => ClientAddress | null;
  upgrade(req: Request, opts: { data: unknown }): boolean;
}

type AgentFetchHandler = (req: Request, server: AgentFetchServer) => Response | Promise<Response>;

/**
 * Infrastructure routes that precede the API surface: health checks,
 * reverse-tunnel endpoints, bootstrap registration, the install
 * script, artifact downloads, and agent self-update/rollback. Order
 * is load-bearing — it mirrors the original route chain exactly.
 * Returns null when no route matched (fall through to the API routes).
 */
function handleInfraRoutes(
  req: Request,
  url: URL,
  server: AgentFetchServer,
  opts: StartAgentOptions,
  tunnelServer: TunnelServer | null,
): Response | Promise<Response> | null {
  if (url.pathname === "/health" || url.pathname === "/healthz") {
    return new Response("ok", { status: 200 });
  }
  // Reverse-tunnel endpoints — gated on opts.tunnelCentral. Both
  // are no-ops when tunnelServer is null (falls through to 404).
  // handleUpgrade returns undefined on a successful upgrade (Bun
  // owns the response) and a 400 Response on upgrade failure. The
  // 101 placeholder is unreachable when the upgrade succeeded
  // (Bun has already taken over the socket); it satisfies the
  // typed Response return shape for the fetch handler.
  if (url.pathname === "/tunnel" && tunnelServer) {
    const upgradeRes = tunnelServer.handleUpgrade(req, server);
    return upgradeRes ?? new Response(null, { status: 101 });
  }
  if (url.pathname.startsWith("/tunnel-relay/") && tunnelServer) {
    return handleTunnelRelay(
      req,
      url,
      forwardingServiceToken(tunnelServer, req),
      opts.tokenHash,
      opts.tunnelJournalPath,
      opts.tunnelCentral?.workerRpcRelay?.()?.tokenHashes ?? [],
    );
  }
  // Bootstrap registration — unauthenticated by design (nodes have
  // no bearer yet; that's what this endpoint mints). Consumes a
  // single-use token from deploy-node, writes to kubeconfig.
  if (url.pathname === "/register") {
    return handleRegister(req, opts.registerOptions ?? {});
  }
  // Install-script endpoint — returns the curl-pipe-sh bootstrap
  // script for the given token. Unauthenticated; the token query
  // param is the capability. Hits /artifacts + /register once the
  // target host runs it.
  if (url.pathname === "/install-agent.sh") {
    return handleInstallScript(req, opts.installScriptOptions ?? {});
  }
  // Artifact server — streams pre-built llamactl-agent binaries
  // to the curl-pipe-sh installer. Public, no auth (the binary is
  // the same thing anyone can compile from git; serving it over
  // TLS with caching is a convenience, not a privilege).
  if (url.pathname.startsWith("/artifacts/")) {
    return handleArtifact(req, url, opts.artifactsOptions ?? {});
  }
  // Agent self-update endpoint — bearer-auth'd POST that takes a
  // raw binary body + X-Sha256 header, atomic-replaces the running
  // binary, and exits so launchd respawns into the new build.
  // Used by `llamactl agent update --node <n>` from the control
  // plane; never exposed unauthenticated.
  if (url.pathname === "/agent/update") {
    return handleAgentUpdate(req, { tokenHash: opts.tokenHash });
  }
  // Companion to /agent/update — restores `<execPath>.previous`
  // over the running binary + exits 0 so launchd respawns the
  // prior version. Symmetric: calling it twice flips back.
  if (url.pathname === "/agent/rollback") {
    return handleAgentRollback(req, { tokenHash: opts.tokenHash });
  }
  return null;
}

/**
 * The tunnel server as one relay request sees it: a worker-RPC caller's
 * single-use service token rides, unread, on the worker-RPC procedures' req
 * frames, named exactly, stamped with the relay principal of the bearer this
 * hop presented, for the node to verify. The relay hop itself stays
 * authorized by central's own bearer.
 */
function forwardingServiceToken(server: TunnelServer, req: Request): TunnelServer {
  const token = req.headers.get(SERVICE_TOKEN_HEADER);
  const bearer = extractBearer(req);
  if (token === null || token === "" || token.length > SERVICE_TOKEN_MAX_LENGTH) return server;
  if (bearer === null) return server;
  const auth = { serviceToken: token, relayPrincipal: relayPrincipalOf(bearer) };
  const withAuth = (frame: Omit<TunnelReq, "type">): Omit<TunnelReq, "type"> =>
    isInferenceRpcProcedure(frame.method) ? { ...frame, auth } : frame;
  return {
    ...server,
    send: (nodeName, frame) => server.send(nodeName, withAuth(frame)),
    sendSubscribe: (nodeName, frame) => server.sendSubscribe(nodeName, withAuth(frame)),
  };
}

/**
 * Bearer-auth'd API routes: metrics, RAG-aware chat completions, the
 * fleet snapshot, and the OpenAI-compatible /v1 gateway. Order is
 * load-bearing — it mirrors the original route chain exactly.
 * Returns null when no route matched (fall through to /trpc).
 */
function handleAuthedApiRoutes(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
): Response | Promise<Response> | null {
  // Prometheus scrape endpoint. Bearer-auth'd like everything else;
  // scrapers can set the standard Authorization header.
  if (url.pathname === "/metrics") {
    return handleMetricsRoute(req, url, clientAddress, opts, gate);
  }
  // RAG-aware chat completions. Plain OpenAI clients can opt into
  // retrieval by adding a `rag: {node, topK?}` extension field, and
  // must include `via: <node>` to name the llamactl node to route
  // chat through. When neither field is present the handler falls
  // through to the legacy openai-proxy path below. Non-POST / other
  // paths under /v1/* fall straight through to handleOpenAIRoute.
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
    if (denied) return denied;
    return handleRagChatCompletions(req, {
      appRouter,
      fallback: (forwarded) => handleOpenAIRoute(forwarded, url, clientAddress, opts, gate),
    });
  }
  if (req.method === "GET" && url.pathname === "/v1/fleet/snapshot") {
    const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
    if (denied) return denied;
    return handleFleetSnapshotRoute(req, {
      ...(opts.fleetJournalPath !== undefined ? { journalPath: opts.fleetJournalPath } : {}),
    });
  }
  // OpenAI-compatible gateway. Anything under /v1/* is bearer-auth'd
  // then either listed (GET /v1/models — static, no upstream call)
  // or proxied straight to the local llama-server so external tools
  // can speak plain OpenAI SDK to the agent's URL.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/v1") {
    return handleOpenAIRoute(req, url, clientAddress, opts, gate);
  }
  return null;
}

function handleMetricsRoute(
  req: Request,
  url: URL,
  clientAddress: ClientAddress | null,
  opts: StartAgentOptions,
  gate: NoAuthGate,
): Response | Promise<Response> {
  const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
  if (denied) return denied;
  return metricsRegistry.metrics().then(
    (text) =>
      new Response(text, {
        status: 200,
        headers: { "content-type": metricsRegistry.contentType },
      }),
  );
}

/**
 * True when every procedure a tRPC request names, under the endpoint, is
 * a worker-RPC procedure named exactly. Batched paths are decoded and
 * split the way tRPC splits them, so a service credential never rides
 * along to another procedure, nor reaches one by another spelling.
 */
function inferenceRpcOnly(pathname: string, endpoint: string): boolean {
  if (!pathname.startsWith(`${endpoint}/`)) return false;
  let paths: string[];
  try {
    paths = decodeURIComponent(pathname.slice(endpoint.length + 1)).split(",");
  } catch {
    return false;
  }
  return paths.every((path) => isInferenceRpcProcedure(path));
}

/**
 * An unbatched `inferenceRpc.negotiate`. It may run without a credential:
 * with no claims it can only answer "not advertised" or a typed refusal,
 * never anything claims-dependent. So an owner that rolled the RPC back
 * answers a direct caller the way it answers a tunneled one, and the
 * caller keeps the existing path on both.
 */
function negotiateOnly(pathname: string, endpoint: string): boolean {
  return pathname === `${endpoint}/inferenceRpc.negotiate`;
}

type InferenceClaims = inferenceRpc.InferenceServiceClaimsV1;

function requestContext(
  opts: StartAgentOptions,
  claims: InferenceClaims | null,
): AgentRouterContext & InferenceRpcContext {
  // Assigned field by field so a renamed context field fails to compile.
  const context: AgentRouterContext & InferenceRpcContext = {};
  if (opts.fleetJournalPath !== undefined) context.fleetJournalPath = opts.fleetJournalPath;
  if (claims !== null) context.inferenceClaims = claims;
  return context;
}

function createAgentFetchHandler(args: {
  opts: StartAgentOptions;
  endpoint: string;
  tunnelServer: TunnelServer | null;
  gate: NoAuthGate;
  workerRpc: WorkerRpcServing | null;
}): AgentFetchHandler {
  const { opts, endpoint, tunnelServer, gate, workerRpc } = args;
  return (req, server) => {
    const url = new URL(req.url);
    const clientAddress = typeof server.requestIP === "function" ? server.requestIP(req) : null;
    opts.onRequest?.(url);
    const infra = handleInfraRoutes(req, url, server, opts, tunnelServer);
    if (infra) return infra;
    const api = handleAuthedApiRoutes(req, url, clientAddress, opts, gate);
    if (api) return api;
    if (!url.pathname.startsWith(endpoint)) {
      return new Response("not found", { status: 404 });
    }
    // A worker-RPC service credential stands in for the operator bearer
    // on the worker-RPC procedures alone, and carries its verified claims; the
    // operator bearer keeps its scope and carries none.
    const claims =
      workerRpc !== null && inferenceRpcOnly(url.pathname, endpoint)
        ? workerRpc.claimsFor(extractBearer(req))
        : null;
    if (claims === null && !negotiateOnly(url.pathname, endpoint)) {
      const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
      if (denied) return denied;
    }
    return fetchRequestHandler({
      req,
      endpoint,
      router: appRouter,
      createContext: () => requestContext(opts, claims),
    });
  };
}

function startBunServer(args: {
  tls: StartAgentOptions["tls"];
  allowPlainHttp: boolean;
  port: number;
  bindHost: string;
  wsConfig: TunnelServer["websocket"] | null;
  fetchHandler: AgentFetchHandler;
}): { server: Bun.Server<unknown>; fingerprint: string | null } {
  const { tls, allowPlainHttp, port, bindHost, wsConfig, fetchHandler } = args;
  let fingerprint: string | null = null;
  // Bun.serve's option type discriminates on whether `websocket` is
  // present, so we can't share a single literal with `websocket?:`
  // optional — the ws-and-no-ws branches construct separately.
  const server =
    tls && !allowPlainHttp
      ? ((): Bun.Server<unknown> => {
          const loaded = loadCert(tls);
          fingerprint = loaded.fingerprint;
          return wsConfig
            ? Bun.serve({
                port,
                hostname: bindHost,
                reusePort: true,
                fetch: fetchHandler,
                websocket: wsConfig,
                tls: { cert: loaded.certPem, key: loaded.keyPem },
                // Composite applies (image pulls + pod readiness polling)
                // routinely run well past Bun.serve's default 10s idle
                // timeout. 255 is Bun.serve's hard ceiling; past that the
                // caller polls compositeStatus subscriptions instead of
                // waiting on the apply mutation.
                idleTimeout: 255,
              })
            : Bun.serve({
                port,
                hostname: bindHost,
                reusePort: true,
                fetch: fetchHandler,
                tls: { cert: loaded.certPem, key: loaded.keyPem },
                idleTimeout: 255,
              });
        })()
      : wsConfig
        ? Bun.serve({
            port,
            hostname: bindHost,
            reusePort: true,
            fetch: fetchHandler,
            websocket: wsConfig,
            idleTimeout: 255,
          })
        : Bun.serve({
            port,
            hostname: bindHost,
            reusePort: true,
            fetch: fetchHandler,
            idleTimeout: 255,
          });
  return { server, fingerprint };
}

function maybePublishAgentMdns(
  opts: StartAgentOptions,
  listenPort: number,
  fingerprint: string | null,
): PublishedAgent | null {
  // LLAMACTL_DISABLE_MDNS=1 forces mDNS off even when tls=true. Needed
  // when bonjour-service v1.3.0 hits a probe collision against a stale
  // cached announcement on the LAN and synchronously emits
  // `console.log(new Error("Service name is already in use"))` — Bun
  // turns that into an unrecoverable async error that wedges the
  // event loop, leaving the HTTP server listening on its TCP port but
  // never serving requests. The try-catch below only covers the
  // synchronous publish call; the dgram-side collision fires later and
  // bypasses it. Until bonjour-service is replaced, the env-var
  // escape hatch keeps long-lived launchd-managed agents stable.
  const mdnsDisabledByEnv =
    process.env["LLAMACTL_DISABLE_MDNS"] === "1" || process.env["LLAMACTL_DISABLE_MDNS"] === "true";
  const shouldAdvertise = !mdnsDisabledByEnv && (opts.advertiseMdns ?? Boolean(opts.tls));
  if (!shouldAdvertise) return null;
  try {
    return publishAgentMdns({
      port: listenPort,
      nodeName: opts.nodeName ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent",
      fingerprint,
      version: opts.version ?? "0.0.0",
    });
  } catch {
    // mDNS is best-effort — platforms without a working multicast
    // interface shouldn't prevent the agent from starting.
    return null;
  }
}

// Reverse-tunnel dial-out — gated on opts.tunnelDial. The HTTP
// server is already up at this point; the tunnel client runs in
// the background and uses its own reconnect loop, so an unreachable
// central never blocks the local agent. Bridges inbound `req`
// frames from central — queries, mutations and subscriptions — into
// the same appRouter the /trpc endpoint serves.
function maybeStartTunnelClient(
  opts: StartAgentOptions,
  workerRpc: WorkerRpcServing | null,
): TunnelClient | null {
  if (!opts.tunnelDial) return null;
  // Central forwards a worker-RPC caller's single-use token on the req
  // frame, bound to this node's tunnel name and to the call; the claims
  // it verifies to ride that request's context only.
  const tokens = createServiceTokenVerifier({
    node: opts.tunnelDial.nodeName,
    // Why, and for which procedure; never the token.
    onRefused: (reason, method) => {
      process.stderr.write(`[worker-rpc] tunnel token refused (${reason}) for ${method}\n`);
    },
  });
  const contextFor = (req: TunnelReq): ReturnType<typeof requestContext> => {
    const params = req.params as { input?: unknown } | undefined;
    const claims =
      workerRpc !== null && isInferenceRpcProcedure(req.method)
        ? tokens.claimsFor(
            req.auth?.serviceToken,
            {
              method: req.method,
              input: params?.input,
              relayPrincipal: req.auth?.relayPrincipal ?? "",
            },
            workerRpc.bindings(),
          )
        : null;
    return requestContext(opts, claims);
  };
  const handleRequest = (req: TunnelReq): Promise<unknown> =>
    createTunnelRouterHandler(appRouter.createCaller(contextFor(req)))(req);
  const handleSubscription = createTunnelSubscriptionHandler(appRouter, contextFor);
  const tunnelClient = createTunnelClient({
    url: opts.tunnelDial.url,
    bearer: opts.tunnelDial.bearer,
    nodeName: opts.tunnelDial.nodeName,
    handleRequest,
    handleSubscription,
    ...(opts.tunnelDial.onStateChange !== undefined
      ? { onStateChange: opts.tunnelDial.onStateChange }
      : {}),
    // Background mode by default: the HTTP server must come up
    // regardless of central's reachability. The reconnect loop
    // handles transient failures on its own schedule.
    initialAttemptTimeoutMs: opts.tunnelDial.initialAttemptTimeoutMs ?? 0,
    ...(opts.tunnelDial.WebSocketCtor !== undefined
      ? { WebSocketCtor: opts.tunnelDial.WebSocketCtor }
      : {}),
  });
  // Fire-and-forget; state transitions are observable via
  // opts.tunnelDial.onStateChange.
  void tunnelClient.start();
  return tunnelClient;
}

// Async best-effort subsystems (mDNS Bonjour probes, the tunnel
// client's reconnect loop, telemetry flushers) can throw
// unhandled rejections + uncaughtExceptions hours after startup.
// In a TTY those land as stderr noise; under launchd the default
// handler kills the process even though the HTTP server is fine.
// Make the agent resilient: log + continue. Once installed, this
// covers ANY future async-leak the agent picks up — not just mDNS.
const captureFatal =
  (kind: string) =>
  (err: unknown): void => {
    process.stderr.write(
      `${kind}: ${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}\n`,
    );
  };

function warnNoAuthEnabled(allowPlainHttp: boolean): void {
  const transport = allowPlainHttp ? "Serving plain HTTP (no TLS)." : "Serving HTTPS.";
  process.stderr.write(
    `[agent] WARNING: --no-auth flag enabled. Bearer token validation BYPASSED for /v1/* connections from 127.0.0.1. All other routes (including /trpc) still require bearer auth. ${transport}\n`,
  );
}

function maybeStartPeerSnapshotPoller(opts: StartAgentOptions): (() => void) | null {
  if (!opts.peerSnapshotPoll) return null;
  return startPeerSnapshotPoller({
    ...(opts.peerSnapshotPollIntervalMs ? { intervalMs: opts.peerSnapshotPollIntervalMs } : {}),
    // The unified dispatch path's shadow catalog reads the same
    // snapshot map the legacy route map gets — publish to both so a
    // flag flip never changes which peer routes are visible.
    publish: (snapshots) => {
      openaiProxy.setPeerSnapshots(snapshots);
      publishUnifiedPeerSnapshots(snapshots);
    },
  });
}

interface WorkerRpcServing {
  /** The service-credential bindings current now. */
  bindings(): readonly ServiceCredentialBinding[];
  /** The claims a service credential carries under the bindings current now. */
  claimsFor(token: string | null | undefined): InferenceClaims | null;
  /** Drains active attempts and cancels what outlives the window. */
  drain(): Promise<void>;
  /** Stops serving the host; called once the HTTP server has stopped. */
  unpublish(): void;
}

// Inside launchd's default 20 s ExitTimeOut, so a SIGTERM'd agent still
// cancels what outlives the drain instead of being killed mid-stream.
const DEFAULT_DRAIN_TIMEOUT_MS = 15_000;
/** How long streams get to deliver their terminal, after a cancel and again on the wire. */
export const TERMINAL_FLUSH_MS = 1_000;

function within(ms: number, work: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  return Promise.race([work.then(() => true), timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Each owner's share of the active attempts when agent.yaml sets none.
 * Undefined, the host's whole cap: with one owner bound to submit there
 * is nobody to keep slots for. Two bindings of one owner, as in a
 * rotation, are still one owner. A binding that cannot submit, such as a
 * status or catalog monitor, never holds a slot, so counting it would
 * only cut the submitters' share.
 */
function defaultActiveShare(bindings: readonly ServiceCredentialBinding[]): number | undefined {
  const owners = new Set(
    bindings
      .filter((b) => b.operations.includes("submit"))
      .map((b) => JSON.stringify([b.serviceId, b.credentialScopeId])),
  );
  return owners.size > 1 ? DEFAULT_SHARED_MAX_ACTIVE_PER_OWNER : undefined;
}

/**
 * Publishes this agent's worker-RPC host (P4.1). It advertises the
 * versions agent.yaml lists that this build speaks, read on every call,
 * so emptying the list stops the advertisement for new requests while
 * accepted attempts run on. Each owner's share of the active attempts is
 * read on every submit too, so it can be changed without a restart, which
 * would drain and then cancel every attempt in flight.
 */
function maybePublishWorkerRpc(opts: StartAgentOptions): WorkerRpcServing | null {
  const config = opts.workerRpc;
  if (config === undefined) return null;
  const spoken = inferenceRpc.inferenceRpcVersionsSpokenAt(inferenceRpc.INFERENCE_RPC_VERSION);
  const host = createWorkerRpcHost({
    workerId: config.workerId,
    ...(config.backends !== undefined ? { backends: config.backends } : {}),
    versions: () =>
      (config.settings()?.versions ?? []).filter((v) =>
        spoken.some((s) => inferenceRpc.compareInferenceRpcVersions(s, v) === 0),
      ),
    maxActiveAttemptsPerOwner: () => {
      const settings = config.settings();
      return (
        settings?.maxActiveAttemptsPerOwner ??
        defaultActiveShare(settings?.serviceCredentials ?? [])
      );
    },
  });
  const restore = publishWorkerRpcHost(host);
  const bindings = (): readonly ServiceCredentialBinding[] =>
    config.settings()?.serviceCredentials ?? [];
  return {
    bindings,
    claimsFor: (token) => claimsForServiceCredential(token, bindings()),
    drain: async (): Promise<void> => {
      const drainMs = config.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
      if (!(await within(drainMs, host.drain()))) {
        // Cancelled attempts end with a typed terminal on their stream.
        host.close();
        await within(TERMINAL_FLUSH_MS, host.drain());
      }
    },
    unpublish: restore,
  };
}

function maybeCreateTunnelServer(opts: StartAgentOptions): TunnelServer | null {
  if (!opts.tunnelCentral) return null;
  return createTunnelServer({
    expectedBearerHash: opts.tunnelCentral.expectedBearerHash,
    ...(opts.tunnelCentral.onNodeConnect !== undefined
      ? { onNodeConnect: opts.tunnelCentral.onNodeConnect }
      : {}),
    ...(opts.tunnelCentral.onNodeDisconnect !== undefined
      ? { onNodeDisconnect: opts.tunnelCentral.onNodeDisconnect }
      : {}),
    // journal.ts resolves undefined → the default path; we just
    // pass through so callers can force a tempfile in tests.
    ...(opts.tunnelJournalPath !== undefined ? { journalPath: opts.tunnelJournalPath } : {}),
  });
}

/**
 * Starts a Bun HTTP(S) server that exposes the llamactl tRPC router
 * behind bearer-token auth. The fetchRequestHandler is the same surface
 * the Electron main process mounts via electron-trpc — one router,
 * three mounts.
 */
export function startAgentServer(opts: StartAgentOptions): RunningAgent {
  const bindHost = opts.bindHost ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const endpoint = opts.endpoint ?? "/trpc";
  const noAuth = opts.noAuth === true;
  const allowPlainHttp = noAuth && isLoopbackAddress(bindHost);

  // Capture the handler references so stop() can remove exactly the
  // pair this call installed. Anonymous re-registration on every
  // startAgentServer would otherwise leak two process listeners per
  // call across restart/test cycles (MaxListeners warning + each
  // still-installed handler firing once per fatal).
  const onUncaughtException = captureFatal("uncaughtException");
  const onUnhandledRejection = captureFatal("unhandledRejection");
  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);

  runStartupMigration();
  if (noAuth) {
    warnNoAuthEnabled(allowPlainHttp);
  }

  startSearchIngest().catch(() => undefined);
  const stopPeerSnapshotPoller = maybeStartPeerSnapshotPoller(opts);
  agentInfo.set(
    {
      node_name: opts.nodeName ?? process.env["LLAMACTL_NODE_NAME"] ?? "agent",
      version: opts.version ?? "0.0.0",
    },
    1,
  );

  const tunnelServer: TunnelServer | null = maybeCreateTunnelServer(opts);

  const gate = makeNoAuthGate(noAuth, bindHost);

  const workerRpc = maybePublishWorkerRpc(opts);

  const fetchHandler = createAgentFetchHandler({ opts, endpoint, tunnelServer, gate, workerRpc });

  const wsConfig = tunnelServer ? tunnelServer.websocket : null;
  const { server, fingerprint } = startBunServer({
    tls: opts.tls,
    allowPlainHttp,
    port,
    bindHost,
    wsConfig,
    fetchHandler,
  });

  const scheme = opts.tls && !allowPlainHttp ? "https" : "http";
  const listenPort = server.port ?? port;

  const mdns = maybePublishAgentMdns(opts, listenPort, fingerprint);

  const tunnelClient = maybeStartTunnelClient(opts, workerRpc);

  return {
    url: `${scheme}://${bindHost}:${String(listenPort)}`,
    port: listenPort,
    fingerprint,
    handleRequest: async (
      req: Request,
      address: ClientAddress | null = null,
    ): Promise<Response> => {
      return await fetchHandler(req, {
        requestIP: () => address,
        // Tunneled requests are synthetic — no socket to upgrade.
        upgrade: () => false,
      });
    },
    stop: async (): Promise<void> => {
      // Worker-RPC attempts drain first, while their transports are up.
      await workerRpc?.drain();
      // Remove exactly the process handlers this call installed so
      // repeated start/stop cycles don't accumulate listeners.
      process.off("uncaughtException", onUncaughtException);
      process.off("unhandledRejection", onUnhandledRejection);
      stopSearchIngest();
      stopPeerSnapshotPoller?.();
      try {
        // A drained or cancelled worker-RPC stream has handed its terminal
        // to its response; let in-flight responses finish before closing.
        // Tunneled calls never pass through the HTTP server, so the tunnel
        // stays up until it is idle too, in the same window. The host stays
        // published until then, so a status or cancel still in flight, over
        // either transport, is answered by the attempts it names.
        if (workerRpc !== null) {
          await within(
            TERMINAL_FLUSH_MS,
            Promise.all([server.stop(), tunnelClient?.whenIdle()]).then(() => undefined),
          );
        }
      } finally {
        // Best-effort — never let a tunnel-client teardown error
        // prevent the HTTP server from also stopping.
        if (tunnelClient) {
          try {
            tunnelClient.stop();
          } catch {
            /* ignore */
          }
        }
        void server.stop(true);
        workerRpc?.unpublish();
        // Last, and bounded: bonjour's stop has no timeout, and a hung one
        // must not keep the tunnel serving or hold stop() open. That keeps
        // stop() within the drain timeout plus three flush windows (the
        // drain's, the shared one above and this one), or two without mDNS.
        if (mdns) {
          await within(
            TERMINAL_FLUSH_MS,
            mdns.stop().catch(() => undefined),
          );
        }
      }
    },
    ...(tunnelServer ? { tunnelServer } : {}),
    ...(tunnelClient ? { tunnelClient } : {}),
  };
}
