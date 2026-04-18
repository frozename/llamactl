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
}

export interface RunningAgent {
  url: string;                // e.g. https://127.0.0.1:7843
  port: number;
  fingerprint: string | null;
  stop: () => Promise<void>;
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

  const fetchHandler = (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    opts.onRequest?.(url);
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
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

  const baseOptions = {
    port,
    hostname: bindHost,
    fetch: fetchHandler,
  };
  let fingerprint: string | null = null;
  const server = opts.tls
    ? (() => {
        const loaded = loadCert(opts.tls);
        fingerprint = loaded.fingerprint;
        return Bun.serve({
          ...baseOptions,
          tls: { cert: loaded.certPem, key: loaded.keyPem },
        });
      })()
    : Bun.serve(baseOptions);

  const scheme = opts.tls ? 'https' : 'http';
  const listenPort = server.port ?? port;
  return {
    url: `${scheme}://${bindHost}:${listenPort}`,
    port: listenPort,
    fingerprint,
    stop: async () => {
      server.stop(true);
    },
  };
}
