// packages/app/e2e/harness/serve.ts — #410 P5b part 1.
// Boots the REAL console server (guards, allowlist, projections,
// serverStop precheck) over the fixture backend, plus a loopback-only
// control server the Playwright specs (P5b part 2) and the Bun
// contract test drive. Loopback binds only; ports 0 mean "pick one"
// and the chosen ports land back on the returned urls.

import type { Server } from "bun";

import { type RunningConsoleServer, startConsoleServer } from "@llamactl/remote";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import {
  createFixtureBackend,
  type FixtureBackend,
  type ServerStopMode,
} from "./fixture-backend.js";
import * as seed from "./fixtures/seed.js";

export interface FixtureConsoleHandle {
  backend: FixtureBackend;
  console: { port: number; url: string };
  control: { hostname: string; port: number; url: string };
  stop(): Promise<void>;
}

export interface StartFixtureConsoleOptions {
  controlPort: number;
  distPath: string;
  port: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    headers: { "content-type": "application/json" },
    status: 400,
  });
}

function ok(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await req.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const STOP_MODES: ReadonlySet<string> = new Set<ServerStopMode>(["not-stopped", "ok", "throw"]);

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not_found" }), {
    headers: { "content-type": "application/json" },
    status: 404,
  });
}

function handleControlPost(
  controls: FixtureBackend["controls"],
  req: Request,
  url: URL,
): Promise<Response> | Response {
  if (url.pathname === "/reset") {
    controls.reset();
    return ok();
  }
  return readJson(req).then((body) => {
    if (body === null) return badRequest("json_object_body_required");
    switch (url.pathname) {
      case "/drop-stream": {
        if (typeof body["node"] !== "string" || typeof body["workload"] !== "string") {
          return badRequest("node_and_workload_required");
        }
        controls.drop(body["node"], body["workload"]);
        return ok();
      }
      case "/emit-log": {
        const { line, node, workload } = body;
        if (typeof line !== "string" || typeof node !== "string" || typeof workload !== "string") {
          return badRequest("node_workload_and_line_required");
        }
        controls.emitLog(node, workload, line);
        return ok();
      }
      case "/reachability": {
        const { node, reachable } = body;
        if (typeof node !== "string" || typeof reachable !== "boolean") {
          return badRequest("node_and_reachable_required");
        }
        controls.setReachable(node, reachable);
        return ok();
      }
      case "/server-stop-mode": {
        const { mode } = body;
        if (typeof mode !== "string" || !STOP_MODES.has(mode)) {
          return badRequest("mode_must_be_ok_not_stopped_or_throw");
        }
        controls.setServerStopMode(mode as ServerStopMode);
        return ok();
      }
      default:
        return notFound();
    }
  });
}

function handleControl(
  backend: FixtureBackend,
  req: Request,
  url: URL,
): Promise<Response> | Response {
  const { controls } = backend;
  if (req.method === "GET") {
    if (url.pathname === "/calls") {
      const node = url.searchParams.get("node");
      if (node === null) return badRequest("node_required");
      return ok({ calls: controls.calls(node) });
    }
    if (url.pathname === "/streams") {
      const node = url.searchParams.get("node");
      if (node === null) return badRequest("node_required");
      return ok({ streams: controls.streams(node) });
    }
    return notFound();
  }
  if (req.method !== "POST") return notFound();
  return handleControlPost(controls, req, url);
}

// The console validates the node segment against the kubeconfig on
// every request, so a standalone boot needs a fixture config on disk.
// The Bun contract test already points LLAMACTL_CONFIG at its own
// temp kubeconfig — never overwrite an existing one.
function ensureFixtureConfig(): () => void {
  const saved = {
    config: process.env["LLAMACTL_CONFIG"],
    storage: process.env["DEV_STORAGE"],
  };
  let tempDir: string | null = null;
  if (saved.config === undefined || saved.config === "") {
    tempDir = mkdtempSync(join(tmpdir(), "llamactl-e2e-cfg-"));
    process.env["LLAMACTL_CONFIG"] = join(tempDir, "config");
    writeFileSync(process.env["LLAMACTL_CONFIG"], seed.E2E_KUBECONFIG_YAML);
    if (saved.storage === undefined || saved.storage === "") {
      mkdirSync(join(tempDir, "storage"), { recursive: true });
      process.env["DEV_STORAGE"] = join(tempDir, "storage");
    }
  }
  return () => {
    if (saved.config === undefined) Reflect.deleteProperty(process.env, "LLAMACTL_CONFIG");
    else process.env["LLAMACTL_CONFIG"] = saved.config;
    if (saved.storage === undefined) Reflect.deleteProperty(process.env, "DEV_STORAGE");
    else process.env["DEV_STORAGE"] = saved.storage;
    if (tempDir !== null) rmSync(tempDir, { force: true, recursive: true });
  };
}

export async function startFixtureConsole(
  opts: StartFixtureConsoleOptions,
): Promise<FixtureConsoleHandle> {
  const restoreEnv = ensureFixtureConfig();
  const backend = createFixtureBackend();
  let consoleServer: RunningConsoleServer;
  try {
    consoleServer = await startConsoleServer({
      backend: backend.router,
      distPath: opts.distPath,
      lookupWorkload: (name: string): unknown => seed.E2E_MODEL_RUNS[name] ?? null,
      port: opts.port,
    });
  } catch (err) {
    restoreEnv();
    throw err;
  }
  let controlServer: Server<unknown>;
  try {
    controlServer = Bun.serve({
      fetch: (req) => handleControl(backend, req, new URL(req.url)),
      hostname: "127.0.0.1",
      port: opts.controlPort,
    });
  } catch (err) {
    await consoleServer.stop().catch(() => undefined);
    restoreEnv();
    throw err;
  }
  const controlPort = controlServer.port ?? opts.controlPort;
  // bun-types types Server.hostname as string | undefined (unix
  // sockets); a TCP bind always reports it.
  const controlHostname = controlServer.hostname ?? "";
  return {
    backend,
    console: { port: consoleServer.port, url: consoleServer.url },
    control: {
      hostname: controlHostname,
      port: controlPort,
      url: `http://${controlHostname}:${String(controlPort)}`,
    },
    stop: async (): Promise<void> => {
      try {
        await Promise.allSettled([consoleServer.stop(), controlServer.stop(true)]);
      } finally {
        restoreEnv();
      }
    },
  };
}

if (import.meta.main) {
  const handle = await startFixtureConsole({
    controlPort: seed.E2E_CONTROL_PORT,
    distPath: join(import.meta.dir, "..", "..", "out", "web"),
    port: seed.E2E_CONSOLE_PORT,
  });
  process.stdout.write(`console: ${handle.console.url}\ncontrol: ${handle.control.url}\n`);
  const shutdown = async (): Promise<void> => {
    await handle.stop();
    process.exit(0);
  };
  const onSignal = (): void => {
    shutdown().catch(() => {
      process.exit(1);
    });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}
