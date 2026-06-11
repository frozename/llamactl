import { openaiProxy } from "@llamactl/core";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ModelRun } from "../workload/schema.js";

import { resolveEnv } from "../../../core/src/env.js";
import { migrateLegacySingletonRuntime } from "../../../core/src/workloadRuntime.js";
import { router as appRouter } from "../router.js";
import { handleFleetSnapshotRoute } from "../routes/fleet.js";
import { startSearchIngest, stopSearchIngest } from "../search/ingest/lifecycle.js";
import {
  type ClientWebSocketConstructor,
  createTunnelClient,
  createTunnelRouterHandler,
  createTunnelServer,
  type TunnelClient,
  type TunnelServer,
  type TunnelState,
} from "../tunnel/index.js";
import { listWorkloads, saveWorkload } from "../workload/store.js";
import { handleAgentRollback, handleAgentUpdate } from "./agent-update.js";
import { type ArtifactsHandlerOptions, handleArtifact } from "./artifacts.js";
import { extractBearer, unauthorizedResponse, verifyBearer } from "./auth.js";
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
    const migration = migrateLegacySingletonRuntime(resolved, listWorkloads());
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
 * valid bearer. Returns the 401 response when the request must be
 * rejected, null when it may proceed.
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
  if (!verifyBearer(req, opts.tokenHash)) {
    return unauthorizedResponse();
  }
  return null;
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
    const res = await openaiProxy.proxyOpenAI(req);
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
    return handleTunnelRelay(req, url, tunnelServer, opts.tokenHash, opts.tunnelJournalPath);
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
    return handleFleetSnapshotRoute(req);
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

function createAgentFetchHandler(args: {
  opts: StartAgentOptions;
  endpoint: string;
  tunnelServer: TunnelServer | null;
  gate: NoAuthGate;
}): AgentFetchHandler {
  const { opts, endpoint, tunnelServer, gate } = args;
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
    const denied = authGateReject(req, url.pathname, clientAddress, opts, gate);
    if (denied) return denied;
    return fetchRequestHandler({
      req,
      endpoint,
      router: appRouter,
      createContext: () => ({}),
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
    process.env.LLAMACTL_DISABLE_MDNS === "1" || process.env.LLAMACTL_DISABLE_MDNS === "true";
  const shouldAdvertise = !mdnsDisabledByEnv && (opts.advertiseMdns ?? Boolean(opts.tls));
  if (!shouldAdvertise) return null;
  try {
    return publishAgentMdns({
      port: listenPort,
      nodeName: opts.nodeName ?? process.env.LLAMACTL_NODE_NAME ?? "agent",
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
// frames from central into the same appRouter the /trpc endpoint
// serves (createCaller({}) — matches the existing /trpc context
// shape).
function maybeStartTunnelClient(opts: StartAgentOptions): TunnelClient | null {
  if (!opts.tunnelDial) return null;
  const caller = appRouter.createCaller({});
  const handleRequest = createTunnelRouterHandler(caller);
  const tunnelClient = createTunnelClient({
    url: opts.tunnelDial.url,
    bearer: opts.tunnelDial.bearer,
    nodeName: opts.tunnelDial.nodeName,
    handleRequest,
    onStateChange: opts.tunnelDial.onStateChange,
    // Background mode by default: the HTTP server must come up
    // regardless of central's reachability. The reconnect loop
    // handles transient failures on its own schedule.
    initialAttemptTimeoutMs: opts.tunnelDial.initialAttemptTimeoutMs ?? 0,
    WebSocketCtor: opts.tunnelDial.WebSocketCtor,
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
  return startPeerSnapshotPoller(
    opts.peerSnapshotPollIntervalMs ? { intervalMs: opts.peerSnapshotPollIntervalMs } : {},
  );
}

function maybeCreateTunnelServer(opts: StartAgentOptions): TunnelServer | null {
  if (!opts.tunnelCentral) return null;
  return createTunnelServer({
    expectedBearerHash: opts.tunnelCentral.expectedBearerHash,
    onNodeConnect: opts.tunnelCentral.onNodeConnect,
    onNodeDisconnect: opts.tunnelCentral.onNodeDisconnect,
    // journal.ts resolves undefined → the default path; we just
    // pass through so callers can force a tempfile in tests.
    journalPath: opts.tunnelJournalPath,
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

  process.on("uncaughtException", captureFatal("uncaughtException"));
  process.on("unhandledRejection", captureFatal("unhandledRejection"));

  runStartupMigration();
  if (noAuth) {
    warnNoAuthEnabled(allowPlainHttp);
  }

  startSearchIngest().catch(() => undefined);
  const stopPeerSnapshotPoller = maybeStartPeerSnapshotPoller(opts);
  agentInfo.set(
    {
      node_name: opts.nodeName ?? process.env.LLAMACTL_NODE_NAME ?? "agent",
      version: opts.version ?? "0.0.0",
    },
    1,
  );

  const tunnelServer: TunnelServer | null = maybeCreateTunnelServer(opts);

  const gate = makeNoAuthGate(noAuth, bindHost);

  const fetchHandler = createAgentFetchHandler({ opts, endpoint, tunnelServer, gate });

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

  const tunnelClient = maybeStartTunnelClient(opts);

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
      stopSearchIngest();
      stopPeerSnapshotPoller?.();
      // Best-effort — never let a tunnel-client teardown error
      // prevent the HTTP server from also stopping.
      if (tunnelClient) {
        try {
          tunnelClient.stop();
        } catch {
          /* ignore */
        }
      }
      if (mdns) await mdns.stop().catch(() => undefined);
      void server.stop(true);
    },
    ...(tunnelServer ? { tunnelServer } : {}),
    ...(tunnelClient ? { tunnelClient } : {}),
  };
}
