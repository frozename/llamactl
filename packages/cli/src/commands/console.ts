// P7-A (#410): `llamactl console` serves the Operator Console web UI
// from packages/app/out/web on loopback only. The HTTP surface —
// guards, session cookie, allowlist, dispatch router — lives in
// @llamactl/remote; this file is flag parsing, dist resolution, the
// platform opener, and the foreground wait. Flag handling is split
// into one small step per flag to stay inside the cognitive-complexity
// lint budget.

import { sourceRevision } from "@llamactl/core";
import { type RunningConsoleServer, startConsoleServer } from "@llamactl/remote";
import { join, resolve } from "node:path";

import { existsSync } from "../safe-fs.js";

const DEFAULT_CONSOLE_PORT = 4520;
const LOOPBACK_HOST = "127.0.0.1";

const CONSOLE_USAGE = `Usage: llamactl console [--port <n>] [--host <h>] [--dist <path>] [--no-open]

Serve the Operator Console web UI on 127.0.0.1 (loopback only).

  --port <n>        Port to listen on (integer 0..65535, 0 for an
                    ephemeral port; default ${String(DEFAULT_CONSOLE_PORT)}).
  --host <h>        Bind host (only 127.0.0.1 is accepted).
  --dist <path>     Path to the built web UI directory. Falls back to
                    LLAMACTL_CONSOLE_DIST, then packages/app/out/web.
  --no-open         Do not open the console in the default browser
                    (a browser is opened by default).
  -h, --help        Show this help message.

The web UI must be built first: bun run --cwd packages/app build:web
`;

interface ConsoleFlags {
  dist: string | undefined;
  open: boolean;
  port: number;
}

type ConsoleParseResult =
  | { ok: true; value: ConsoleFlags }
  | { ok: false; help: true }
  | { ok: false; code: number; error: string; help: false };

type FlagStep = { kind: "error"; error: string } | { kind: "help" } | { kind: "ok"; next: number };

type FlagValue = { ok: true; next: number; value: string } | { ok: false; error: string };

function flagValue(args: string[], index: number, arg: string, name: string): FlagValue {
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    const inline = arg.slice(eq + 1);
    return inline === ""
      ? { ok: false, error: `${name} requires a value` }
      : { ok: true, next: index, value: inline };
  }
  const following = args[index + 1];
  return following === undefined
    ? { ok: false, error: `${name} requires a value` }
    : { ok: true, next: index + 1, value: following };
}

function parsePort(raw: string): number | null {
  if (raw.trim() === "") return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : null;
}

function stepPort(args: string[], index: number, arg: string, flags: ConsoleFlags): FlagStep {
  const taken = flagValue(args, index, arg, "--port");
  if (!taken.ok) return { kind: "error", error: taken.error };
  const port = parsePort(taken.value);
  if (port === null) {
    return {
      kind: "error",
      error: `--port must be an integer between 0 and 65535, got "${taken.value}"`,
    };
  }
  flags.port = port;
  return { kind: "ok", next: taken.next };
}

function stepHost(args: string[], index: number, arg: string): FlagStep {
  const taken = flagValue(args, index, arg, "--host");
  if (!taken.ok) return { kind: "error", error: taken.error };
  if (taken.value !== LOOPBACK_HOST) {
    return {
      kind: "error",
      error: `binds loopback only (${LOOPBACK_HOST}); refusing --host ${taken.value}`,
    };
  }
  return { kind: "ok", next: taken.next };
}

function stepDist(args: string[], index: number, arg: string, flags: ConsoleFlags): FlagStep {
  const taken = flagValue(args, index, arg, "--dist");
  if (!taken.ok) return { kind: "error", error: taken.error };
  flags.dist = taken.value;
  return { kind: "ok", next: taken.next };
}

function parseOneFlag(args: string[], index: number, flags: ConsoleFlags): FlagStep {
  const arg = args[index];
  if (arg === undefined) return { kind: "error", error: "unexpected end of arguments" };
  if (arg === "-h" || arg === "--help") return { kind: "help" };
  if (arg === "--no-open") {
    flags.open = false;
    return { kind: "ok", next: index };
  }
  if (arg === "--port" || arg.startsWith("--port=")) {
    return stepPort(args, index, arg, flags);
  }
  if (arg === "--host" || arg.startsWith("--host=")) return stepHost(args, index, arg);
  if (arg === "--dist" || arg.startsWith("--dist=")) {
    return stepDist(args, index, arg, flags);
  }
  return { kind: "error", error: `unknown flag: ${arg}` };
}

function parseConsoleFlags(args: string[]): ConsoleParseResult {
  const flags: ConsoleFlags = { dist: undefined, open: true, port: DEFAULT_CONSOLE_PORT };
  let index = 0;
  while (index < args.length) {
    const step = parseOneFlag(args, index, flags);
    if (step.kind === "help") return { ok: false, help: true };
    if (step.kind === "error") {
      return { ok: false, code: 2, error: step.error, help: false };
    }
    index = step.next + 1;
  }
  return { ok: true, value: flags };
}

// The app build output inside the source checkout this CLI runs from.
// Located via the checkout root rather than a path climb into the
// sibling package; falls back to the working directory outside a checkout.
function defaultDistDir(): string {
  const root = sourceRevision.findRepoRoot(import.meta.dir) ?? process.cwd();
  return join(root, "packages", "app", "out", "web");
}

// Dist resolution order per the #410 plan: --dist flag, then
// LLAMACTL_CONSOLE_DIST, then the repo checkout's app build output.
function resolveDistPath(flagDist: string | undefined): string {
  const envDist = process.env["LLAMACTL_CONSOLE_DIST"];
  const fallback = envDist === undefined || envDist === "" ? undefined : envDist;
  return resolve(flagDist ?? fallback ?? defaultDistDir());
}

// The browser opener is fire-and-forget: the spawned helper must be
// unref'd because Bun waits for every spawned subprocess before
// shutting down, and a wedged opener (headless xdg-open probing for a
// browser) would otherwise hold the console's exit open. Whatever the
// opener does — spawn throws, exited rejects, or it exits non-zero —
// the console only warns; its own exit is never affected.
export interface ConsoleOpenerProc {
  unref(): void;
  exited: Promise<number>;
}

export interface ConsoleOpenerSpawnOptions {
  stdin: "ignore";
  stdout: "ignore";
  stderr: "ignore";
}

export type ConsoleOpenerSpawn = (
  argv: string[],
  options: ConsoleOpenerSpawnOptions,
) => ConsoleOpenerProc;

function spawnConsoleOpener(argv: string[], options: ConsoleOpenerSpawnOptions): ConsoleOpenerProc {
  return Bun.spawn(argv, options);
}

function openerArgv(platform: NodeJS.Platform, url: string): string[] {
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["cmd", "/c", "start", "", url];
  // linux and the remaining unix-likes share the freedesktop opener.
  return ["xdg-open", url];
}

function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawn: ConsoleOpenerSpawn = spawnConsoleOpener,
): void {
  let proc: ConsoleOpenerProc;
  try {
    proc = spawn(openerArgv(platform, url), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    process.stderr.write(`llamactl console: could not open a browser; open ${url} manually\n`);
    return;
  }
  proc.unref();
  void proc.exited
    .then((code) => {
      if (code !== 0) {
        process.stderr.write(`llamactl console: could not open a browser; open ${url} manually\n`);
      }
    })
    .catch(() => {
      process.stderr.write(`llamactl console: could not open a browser; open ${url} manually\n`);
    });
}

interface ShutdownSignals {
  wait: Promise<void>;
  dispose(): void;
}

// #535: a SIGTERM landing between the `Console:` print and the listener
// install used to hit the default disposition and exit 143 on Linux CI,
// so the handlers are installed before the URL is printed and before the
// opener spawns. `on` instead of `once` so a repeated signal arriving
// while the server stops is swallowed rather than falling through to the
// default disposition. Resolving twice is harmless; dispose() runs only
// after stop finishes so the handlers never leak.
function installShutdownSignals(): ShutdownSignals {
  let release: () => void = () => undefined;
  const wait = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const onSignal = (): void => {
    release();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    wait,
    dispose(): void {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    },
  };
}

export interface ConsoleDeps {
  openBrowser?: (url: string) => void;
  waitForShutdown?: () => Promise<void>;
  /** Test seams forwarded to the default opener when openBrowser is unset. */
  platform?: NodeJS.Platform;
  spawn?: ConsoleOpenerSpawn;
}

export async function runConsole(args: string[], deps: ConsoleDeps = {}): Promise<number> {
  const parsed = parseConsoleFlags(args);
  if (!parsed.ok) {
    if (parsed.help) {
      process.stdout.write(CONSOLE_USAGE);
      return 0;
    }
    process.stderr.write(`llamactl console: ${parsed.error}\n`);
    return parsed.code;
  }

  const { dist: distFlag, open, port } = parsed.value;
  const distPath = resolveDistPath(distFlag);
  const indexHtml = join(distPath, "index.html");
  if (!existsSync(indexHtml)) {
    process.stderr.write(
      `llamactl console: web console build not found at ${indexHtml}; run \`bun run --cwd packages/app build:web\` first\n`,
    );
    return 1;
  }

  let server: RunningConsoleServer;
  try {
    server = await startConsoleServer({ distPath, hostname: LOOPBACK_HOST, port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `llamactl console: cannot listen on ${LOOPBACK_HOST}:${String(port)}: ${message}\n`,
    );
    return 1;
  }

  return await serveUntilShutdown(server, open, deps);
}

async function serveUntilShutdown(
  server: RunningConsoleServer,
  open: boolean,
  deps: ConsoleDeps,
): Promise<number> {
  const signals = deps.waitForShutdown === undefined ? installShutdownSignals() : undefined;
  try {
    process.stdout.write(`Console: ${server.url}\nPress Ctrl+C to stop.\n`);
    if (open) {
      if (deps.openBrowser !== undefined) {
        deps.openBrowser(server.url);
      } else {
        openBrowser(server.url, deps.platform, deps.spawn);
      }
    }
    await (deps.waitForShutdown?.() ?? signals?.wait);
    await server.stop();
    process.stdout.write("Console stopped.\n");
    return 0;
  } finally {
    signals?.dispose();
  }
}
