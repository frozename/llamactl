import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { openaiProxy } from '@llamactl/core';
import { router as appRouter } from '../router.js';
import { verifyBearer } from './auth.js';
import { loadCert } from './tls.js';
import {
  agentInfo,
  llamaServerUp,
  openaiPathBucket,
  openaiRequestDurationSeconds,
  openaiRequestsTotal,
  openaiUpstreamErrorsTotal,
  registry as metricsRegistry,
  statusClass,
} from './metrics.js';
import { publishAgentMdns, type PublishedAgent } from './mdns.js';
import { handleRegister, type RegisterHandlerOptions } from './register.js';
import {
  handleInstallScript,
  type InstallScriptHandlerOptions,
} from './install-script.js';
import { handleArtifact, type ArtifactsHandlerOptions } from './artifacts.js';
import { handleRagChatCompletions } from './rag-chat-endpoint.js';
import { handleTunnelRelay } from './tunnel-relay.js';
import {
  createTunnelClient,
  createTunnelRouterHandler,
  createTunnelServer,
  type TunnelClient,
  type TunnelServer,
  type TunnelState,
} from '../tunnel/index.js';

export interface StartAgentOptions {
  bindHost?: string;          // default '127.0.0.1'
  port?: number;              // default 0 (let OS pick)
  endpoint?: string;          // default '/trpc'
  tokenHash: string;          // SHA-256 hex of the expected bearer token
  tls?: { certPath: string; keyPath: string };  // omit for plain HTTP (test-only)
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    WebSocketCtor?: any;
  };
}

export interface RunningAgent {
  url: string;                // e.g. https://127.0.0.1:7843
  port: number;
  fingerprint: string | null;
  stop: () => Promise<void>;
  /** Present only when StartAgentOptions.tunnelCentral was set. */
  tunnelServer?: TunnelServer;
  /** Present only when StartAgentOptions.tunnelDial was set. */
  tunnelClient?: TunnelClient;
}

/**
 * Starts a Bun HTTP(S) server that exposes the llamactl tRPC router
 * behind bearer-token auth. The fetchRequestHandler is the same surface
 * the Electron main process mounts via electron-trpc — one router,
 * three mounts.
 */
export function startAgentServer(opts: StartAgentOptions): RunningAgent {
  const bindHost = opts.bindHost ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const endpoint = opts.endpoint ?? '/trpc';

  agentInfo.set(
    {
      node_name: opts.nodeName ?? process.env.LLAMACTL_NODE_NAME ?? 'agent',
      version: opts.version ?? '0.0.0',
    },
    1,
  );

  const tunnelServer: TunnelServer | null = opts.tunnelCentral
    ? createTunnelServer({
        expectedBearerHash: opts.tunnelCentral.expectedBearerHash,
        onNodeConnect: opts.tunnelCentral.onNodeConnect,
        onNodeDisconnect: opts.tunnelCentral.onNodeDisconnect,
        // journal.ts resolves undefined → the default path; we just
        // pass through so callers can force a tempfile in tests.
        journalPath: opts.tunnelJournalPath,
      })
    : null;

  async function handleOpenAI(req: Request, url: URL): Promise<Response> {
    if (!verifyBearer(req, opts.tokenHash)) {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
      });
    }
    const pathLabel = openaiPathBucket(url.pathname);
    const endTimer = openaiRequestDurationSeconds.startTimer({ path: pathLabel });
    let status = 0;
    try {
      if (req.method === 'GET' && url.pathname === '/v1/models') {
        const models = openaiProxy.listOpenAIModels();
        llamaServerUp.set(models.data.length > 0 ? 1 : 0);
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

  const fetchHandler = (
    req: Request,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    server: any,
  ): Response | Promise<Response> => {
    const url = new URL(req.url);
    opts.onRequest?.(url);
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
    }
    // Reverse-tunnel endpoints — gated on opts.tunnelCentral. Both
    // are no-ops when tunnelServer is null (falls through to 404).
    // handleUpgrade returns undefined on a successful upgrade (Bun
    // owns the response) and a 400 Response on upgrade failure. The
    // 101 placeholder is unreachable when the upgrade succeeded
    // (Bun has already taken over the socket); it satisfies the
    // typed Response return shape for the fetch handler.
    if (url.pathname === '/tunnel' && tunnelServer) {
      const upgradeRes = tunnelServer.handleUpgrade(req, server);
      return upgradeRes ?? new Response(null, { status: 101 });
    }
    if (url.pathname.startsWith('/tunnel-relay/') && tunnelServer) {
      return handleTunnelRelay(
        req,
        url,
        tunnelServer,
        opts.tokenHash,
        opts.tunnelJournalPath,
      );
    }
    // Bootstrap registration — unauthenticated by design (nodes have
    // no bearer yet; that's what this endpoint mints). Consumes a
    // single-use token from deploy-node, writes to kubeconfig.
    if (url.pathname === '/register') {
      return handleRegister(req, opts.registerOptions ?? {});
    }
    // Install-script endpoint — returns the curl-pipe-sh bootstrap
    // script for the given token. Unauthenticated; the token query
    // param is the capability. Hits /artifacts + /register once the
    // target host runs it.
    if (url.pathname === '/install-agent.sh') {
      return handleInstallScript(req, opts.installScriptOptions ?? {});
    }
    // Artifact server — streams pre-built llamactl-agent binaries
    // to the curl-pipe-sh installer. Public, no auth (the binary is
    // the same thing anyone can compile from git; serving it over
    // TLS with caching is a convenience, not a privilege).
    if (url.pathname.startsWith('/artifacts/')) {
      return handleArtifact(req, url, opts.artifactsOptions ?? {});
    }
    // Prometheus scrape endpoint. Bearer-auth'd like everything else;
    // scrapers can set the standard Authorization header.
    if (url.pathname === '/metrics') {
      if (!verifyBearer(req, opts.tokenHash)) {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
        });
      }
      return metricsRegistry.metrics().then(
        (text) =>
          new Response(text, {
            status: 200,
            headers: { 'content-type': metricsRegistry.contentType },
          }),
      );
    }
    // RAG-aware chat completions. Plain OpenAI clients can opt into
    // retrieval by adding a `rag: {node, topK?}` extension field, and
    // must include `via: <node>` to name the llamactl node to route
    // chat through. When neither field is present the handler falls
    // through to the legacy openai-proxy path below. Non-POST / other
    // paths under /v1/* fall straight through to handleOpenAI.
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      if (!verifyBearer(req, opts.tokenHash)) {
        return new Response('unauthorized', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
        });
      }
      return handleRagChatCompletions(req, {
        appRouter,
        fallback: (forwarded) => handleOpenAI(forwarded, url),
      });
    }
    // OpenAI-compatible gateway. Anything under /v1/* is bearer-auth'd
    // then either listed (GET /v1/models — static, no upstream call)
    // or proxied straight to the local llama-server so external tools
    // can speak plain OpenAI SDK to the agent's URL.
    if (url.pathname.startsWith('/v1/') || url.pathname === '/v1') {
      return handleOpenAI(req, url);
    }
    if (!url.pathname.startsWith(endpoint)) {
      return new Response('not found', { status: 404 });
    }
    if (!verifyBearer(req, opts.tokenHash)) {
      return new Response('unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="llamactl-agent"' },
      });
    }
    return fetchRequestHandler({
      req,
      endpoint,
      router: appRouter,
      createContext: () => ({}),
    });
  };

  let fingerprint: string | null = null;
  // Bun.serve's option type discriminates on whether `websocket` is
  // present, so we can't share a single literal with `websocket?:`
  // optional — the ws-and-no-ws branches construct separately.
  const wsConfig = tunnelServer ? tunnelServer.websocket : null;
  const server = opts.tls
    ? (() => {
        const loaded = loadCert(opts.tls);
        fingerprint = loaded.fingerprint;
        return wsConfig
          ? Bun.serve({
              port,
              hostname: bindHost,
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
              fetch: fetchHandler,
              tls: { cert: loaded.certPem, key: loaded.keyPem },
              idleTimeout: 255,
            });
      })()
    : wsConfig
      ? Bun.serve({
          port,
          hostname: bindHost,
          fetch: fetchHandler,
          websocket: wsConfig,
          idleTimeout: 255,
        })
      : Bun.serve({
          port,
          hostname: bindHost,
          fetch: fetchHandler,
          idleTimeout: 255,
        });

  const scheme = opts.tls ? 'https' : 'http';
  const listenPort = server.port ?? port;

  let mdns: PublishedAgent | null = null;
  const shouldAdvertise = opts.advertiseMdns ?? Boolean(opts.tls);
  if (shouldAdvertise) {
    try {
      mdns = publishAgentMdns({
        port: listenPort,
        nodeName: opts.nodeName ?? process.env.LLAMACTL_NODE_NAME ?? 'agent',
        fingerprint,
        version: opts.version ?? '0.0.0',
      });
    } catch {
      // mDNS is best-effort — platforms without a working multicast
      // interface shouldn't prevent the agent from starting.
      mdns = null;
    }
  }

  // Reverse-tunnel dial-out — gated on opts.tunnelDial. The HTTP
  // server is already up at this point; the tunnel client runs in
  // the background and uses its own reconnect loop, so an unreachable
  // central never blocks the local agent. Bridges inbound `req`
  // frames from central into the same appRouter the /trpc endpoint
  // serves (createCaller({}) — matches the existing /trpc context
  // shape on line 244 above).
  let tunnelClient: TunnelClient | null = null;
  if (opts.tunnelDial) {
    const caller = appRouter.createCaller({});
    const handleRequest = createTunnelRouterHandler(caller);
    tunnelClient = createTunnelClient({
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
  }

  return {
    url: `${scheme}://${bindHost}:${listenPort}`,
    port: listenPort,
    fingerprint,
    stop: async () => {
      // Best-effort — never let a tunnel-client teardown error
      // prevent the HTTP server from also stopping.
      if (tunnelClient) {
        try { tunnelClient.stop(); } catch { /* ignore */ }
      }
      await mdns?.stop().catch(() => {});
      server.stop(true);
    },
    ...(tunnelServer ? { tunnelServer } : {}),
    ...(tunnelClient ? { tunnelClient } : {}),
  };
}
