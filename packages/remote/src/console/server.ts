// Bun-hosted, loopback-only operator console server for #410 P2b/P3.
// Guards run in order Host → (api) Sec-Fetch-Site/Origin → session
// cookie → node segment → batch path; the API mount is per-request:
// `/api/n/:node/trpc/*` validates the node against the kubeconfig and
// binds it into ctx, so concurrent tabs cannot redirect each other and
// the kubeconfig defaultNode never substitutes for the path node.
// "Duplicate tab" copying sessionStorage is the client's concern
// (P3 client slice). Static serving folds in the plan's static.ts
// (SPA fallback for extensionless paths only). The default backend is
// fail-closed: an unresolvable dispatch target is a PRECONDITION_FAILED,
// never a silent fallthrough to the local caller.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { extname, join, resolve, sep } from "node:path";

import { makePinnedFetch } from "../client/links.js";
import { buildDispatchRouter } from "../dispatch/router.js";
import { existsSync, statSync } from "../safe-fs.js";
import { buildConsoleRouter, CONSOLE_ALLOWLIST } from "./allowlist.js";
import {
  checkConsoleHost,
  checkConsoleSameOrigin,
  checkConsoleSession,
  checkConsoleTrpcPath,
  type ConsoleSession,
  newConsoleSession,
} from "./guards.js";
import { parseConsoleNodePath, validateConsoleNode } from "./node-route.js";

export interface StartConsoleServerOptions {
  port: number;
  distPath: string;
  hostname?: string;
  backend?: unknown;
  lookupWorkload?: unknown;
}

export interface RunningConsoleServer {
  port: number;
  url: string;
  stop(): Promise<void>;
}

const CSP =
  "default-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function withSecurityHeaders(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  const init: ResponseInit = { status: res.status, statusText: res.statusText, headers };
  if (res.body === null || res.status === 204 || res.status === 205 || res.status === 304) {
    return new Response(null, init);
  }
  return new Response(res.body, init);
}

export function startConsoleServer(opts: StartConsoleServerOptions): Promise<RunningConsoleServer> {
  const hostname = opts.hostname ?? "127.0.0.1";
  if (hostname !== "127.0.0.1") {
    return Promise.reject(
      new Error(
        `startConsoleServer binds loopback only: hostname must be "127.0.0.1", got "${hostname}"`,
      ),
    );
  }
  const backend =
    opts.backend ??
    buildDispatchRouter({
      fetchFactory: makePinnedFetch,
      nodeFromCtx: (ctx) => ctx.node ?? null,
      onUnresolvable: "error",
    });
  const consoleRouter = buildConsoleRouter(backend);
  const trpcNames = new Set(Object.keys(CONSOLE_ALLOWLIST));
  const distPath = resolve(opts.distPath);

  let session: ConsoleSession | null = null;
  const currentSession = (): ConsoleSession => {
    if (session === null) throw new Error("console session not bound yet");
    return session;
  };

  const handleApi = (req: Request, pathname: string): Response | Promise<Response> => {
    const denied = checkConsoleSameOrigin(req) ?? checkConsoleSession(req, currentSession());
    if (denied !== null) return denied;
    const route = parseConsoleNodePath(pathname);
    if (route.kind === "none") return jsonError(404, "not_found");
    if (route.kind === "bad") return jsonError(400, "bad_node");
    const check = checkConsoleTrpcPath(route.procPath, trpcNames);
    if (!check.ok) return jsonError(check.status, check.error);
    const validated = validateConsoleNode(route.node);
    if (!validated.ok) return jsonError(validated.status, validated.error);
    const node = validated.node;
    return fetchRequestHandler({
      endpoint: route.endpoint,
      req,
      router: consoleRouter,
      createContext: () => ({ node }),
    });
  };

  const serveStatic = (pathname: string): Response => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return jsonError(403, "bad_path");
    }
    if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) {
      return jsonError(403, "bad_path");
    }
    const target = resolve(join(distPath, decoded));
    if (target !== distPath && !target.startsWith(distPath + sep)) {
      return jsonError(403, "bad_path");
    }
    if (existsSync(target) && statSync(target).isFile()) return new Response(Bun.file(target));
    if (extname(decoded) !== "") return jsonError(404, "not_found");
    const indexPath = join(distPath, "index.html");
    if (!existsSync(indexPath)) return jsonError(404, "not_found");
    return new Response(Bun.file(indexPath), {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": CSP,
        "content-type": "text/html; charset=utf-8",
        "set-cookie": currentSession().setCookie,
      },
      status: 200,
    });
  };

  let boundPort = opts.port;

  const secure = (res: Response | Promise<Response>): Response | Promise<Response> =>
    res instanceof Promise ? res.then(withSecurityHeaders) : withSecurityHeaders(res);

  const server = Bun.serve({
    hostname,
    port: opts.port,
    idleTimeout: 255,
    fetch: (req) => {
      const url = new URL(req.url);
      const denied = checkConsoleHost(req, boundPort);
      if (denied !== null) return secure(denied);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return secure(handleApi(req, url.pathname));
      }
      return secure(serveStatic(url.pathname));
    },
  });
  const port = server.port ?? opts.port;
  boundPort = port;
  session = newConsoleSession(port);

  return Promise.resolve({
    port,
    url: `http://127.0.0.1:${String(port)}`,
    stop: async (): Promise<void> => {
      await server.stop(true);
    },
  });
}
