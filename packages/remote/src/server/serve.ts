import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { router as appRouter } from '../router.js';
import { verifyBearer } from './auth.js';
import { loadCert } from './tls.js';

export interface StartAgentOptions {
  bindHost?: string;          // default '127.0.0.1'
  port?: number;              // default 0 (let OS pick)
  endpoint?: string;          // default '/trpc'
  tokenHash: string;          // SHA-256 hex of the expected bearer token
  tls?: { certPath: string; keyPath: string };  // omit for plain HTTP (test-only)
  onRequest?: (url: URL) => void;
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

  const fetchHandler = (req: Request): Response | Promise<Response> => {
    const url = new URL(req.url);
    opts.onRequest?.(url);
    if (url.pathname === '/healthz') {
      return new Response('ok', { status: 200 });
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
