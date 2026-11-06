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
import { buildConsoleRouter, CONSOLE_ALLOWLIST, type ConsoleLookupWorkload } from "./allowlist.js";
import {
  checkConsoleHost,
  checkConsoleSameOrigin,
  checkConsoleSession,
  checkConsoleTrpcPath,
  type ConsoleSession,
  newConsoleSession,
} from "./guards.js";
import { parseConsoleNodePath, validateConsoleNode } from "./node-route.js";

interface TrpcErrorRow {
  error: {
    code: number;
    data: { code: string; httpStatus: number };
    message: string;
  };
}

function trpcErrorRow(code: "BAD_REQUEST" | "METHOD_NOT_SUPPORTED", message: string): TrpcErrorRow {
  return code === "METHOD_NOT_SUPPORTED"
    ? {
        error: {
          code: -32005,
          data: { code, httpStatus: 405 },
          message,
        },
      }
    : {
        error: {
          code: -32000,
          data: { code, httpStatus: 400 },
          message,
        },
      };
}

export type ConsoleRouter = ReturnType<typeof buildConsoleRouter>;

// tRPC 11.16 rejects a batch that mixes procedure types with a single
// parse-level 400 before any per-call METHOD_NOT_SUPPORTED check runs, so
// a hand-built GET batch of a query plus the serverStop mutation would
// never see the per-row rejection the console contract pins (#410 P5a).
// Emulate that shape: query segments still run through tRPC; mutation
// segments get a METHOD_NOT_SUPPORTED row and never reach the precheck or
// the backend. Non-allowlisted names were already rejected by the guard,
// so only listed identifiers reach the rewritten inner path.
function remapBatchInput(
  rawInput: string,
  names: string[],
  kept: string[],
  keptIdx: number[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const remapped: Record<string, unknown> = {};
  for (const [newIndex, sourceIdx] of keptIdx.entries()) {
    const value = source[String(sourceIdx)];
    if (value !== undefined) remapped[String(newIndex)] = value;
  }
  return remapped;
}

function filterNonMutationSegments(
  names: string[],
  mutations: ReadonlySet<string>,
): { kept: string[]; keptIdx: number[] } {
  const kept: string[] = [];
  const keptIdx: number[] = [];
  for (const [i, name] of names.entries()) {
    if (!mutations.has(name)) {
      kept.push(name);
      keptIdx.push(i);
    }
  }
  return { kept, keptIdx };
}

async function handleBatchWithMutation(
  req: Request,
  endpoint: string,
  names: string[],
  node: string,
  router: ConsoleRouter,
): Promise<Response | null> {
  if (req.method === "POST") return null;
  const url = new URL(req.url);
  if (url.searchParams.get("batch") !== "1") return null;
  const mutations = new Set(names.filter((name) => CONSOLE_ALLOWLIST[name]?.type === "mutation"));
  if (mutations.size === 0) return null;
  const { kept, keptIdx } = filterNonMutationSegments(names, mutations);
  const params = new URLSearchParams(url.searchParams);
  const rawInput = params.get("input");
  if (rawInput !== null && kept.length > 0) {
    const remapped = remapBatchInput(rawInput, names, kept, keptIdx);
    if (remapped === null) return null;
    params.set("input", JSON.stringify(remapped));
  }
  let rows: unknown[] = [];
  if (kept.length > 0) {
    const inner = new URL(url.href);
    inner.pathname = `${endpoint}/${kept.join(",")}`;
    inner.search = params.toString();
    const res = await fetchRequestHandler({
      endpoint,
      req: new Request(inner.href, { method: req.method, headers: req.headers }),
      router,
      createContext: () => ({ node }),
    });
    const body: unknown = await res.json();
    rows = Array.isArray(body) ? body : [];
  }
  let cursor = 0;
  const combined = names.map((name) =>
    mutations.has(name)
      ? trpcErrorRow(
          "METHOD_NOT_SUPPORTED",
          `Unsupported ${req.method}-request to mutation procedure at path "${name}"`,
        )
      : (rows[cursor++] ??
        trpcErrorRow("BAD_REQUEST", "Cannot mix procedure types in call: query, mutation")),
  );
  return new Response(JSON.stringify(combined), {
    status: 405,
    headers: { "content-type": "application/json" },
  });
}

export interface StartConsoleServerOptions {
  port: number;
  distPath: string;
  hostname?: string;
  backend?: unknown;
  /**
   * Test-only seam for the serverStop precheck; no CLI flag. Typed
   * `unknown` so the ConsoleStarter seam in test/console/helpers.ts,
   * which forwards `unknown` by contract, can pass this function
   * through under strictFunctionTypes; non-functions fall back to
   * defaultLookupWorkload.
   */
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
  const lookupWorkload: ConsoleLookupWorkload | undefined =
    typeof opts.lookupWorkload === "function"
      ? (opts.lookupWorkload as ConsoleLookupWorkload)
      : undefined;
  const consoleRouter = buildConsoleRouter(
    backend,
    lookupWorkload === undefined ? {} : { lookupWorkload },
  );
  const trpcNames = new Set(Object.keys(CONSOLE_ALLOWLIST));
  const distPath = resolve(opts.distPath);

  let session: ConsoleSession | null = null;
  const currentSession = (): ConsoleSession => {
    if (session === null) throw new Error("console session not bound yet");
    return session;
  };

  const handleApi = async (req: Request, pathname: string): Promise<Response> => {
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
    const batched = await handleBatchWithMutation(
      req,
      route.endpoint,
      check.names,
      node,
      consoleRouter,
    );
    if (batched !== null) return batched;
    return await fetchRequestHandler({
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
