import { env as envMod, keepAlive } from "@llamactl/core";
import { spawn } from "node:child_process";

import { getGlobals, getNodeClient, isLocalDispatch } from "../dispatcher.js";
import { required } from "../required.js";
import { resolveWorkloadName } from "./_workload-resolve.js";

const USAGE = `Usage: llamactl keep-alive <subcommand>

Subcommands:
  start <target> [--json]
      Launch a detached supervisor that keeps llama-server running,
      restarting it with exponential backoff (up to
      LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF seconds) when /health drops.
      Health is polled every LLAMA_CPP_KEEP_ALIVE_INTERVAL seconds
      (default 5).

  stop [--name <workload>] [--grace=<s>] [--json]
      Touch the supervisor's stop file and wait up to <grace> seconds
      before SIGTERM. The tracked llama-server is stopped too.

  status [--json]
      Report whether the supervisor is running and print its last
      state snapshot (target / model / state / restarts / backoff).

  worker <target> [--interval=<s>] [--max-backoff=<s>]
      Internal entry point run by \`start\` inside a detached bun
      subprocess. Invoking this directly blocks until the stop file
      is written or the process is terminated.
`;

interface JsonPositionalArgs {
  json: boolean;
  positional: string[];
}

/** Shared --json / --help / positional parsing for `start` and `status`. */
function parseJsonPositionalArgs(args: string[]): JsonPositionalArgs | { exit: number } {
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return { exit: 0 };
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return { exit: 1 };
    } else positional.push(arg);
  }
  return { json, positional };
}

// Remote path: the agent spawns its own supervisor — mirrors the
// local flow but on the target node's machine.
async function runStartRemote(target: string, json: boolean): Promise<number> {
  try {
    const res = await getNodeClient().keepAliveStart.mutate({ target });
    if (json) {
      process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    } else if (!res.ok) {
      process.stderr.write(`${res.error ?? "keep-alive failed to start"}\n`);
    } else {
      process.stdout.write(`keep-alive started pid=${String(res.pid)} target=${target} (remote)\n`);
    }
    return res.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(
      `keep-alive start: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return 1;
  }
}

/**
 * Wait briefly for the worker to write its pid file so the user's
 * `status` call immediately after start returns something useful.
 */
async function waitForSupervisorPid(): Promise<number | null> {
  const startedAt = Date.now();
  let pid: number | null = null;
  while (Date.now() - startedAt < 2000) {
    pid = keepAlive.readKeepAlivePid();
    if (pid !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pid;
}

function reportStartResult(pid: number | null, target: string, json: boolean): number {
  const report = {
    ok: pid !== null,
    pid,
    target,
    log: keepAlive.keepAliveLogFile(),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (pid === null) {
      process.stderr.write("keep-alive supervisor did not register a PID within 2s\n");
    } else {
      process.stdout.write(
        `keep-alive started pid=${String(pid)} target=${target} log=${report.log}\n`,
      );
    }
  }
  return pid !== null ? 0 : 1;
}

async function runStart(args: string[]): Promise<number> {
  const parsed = parseJsonPositionalArgs(args);
  if ("exit" in parsed) return parsed.exit;
  const json = parsed.json;
  const target = parsed.positional[0] ?? "current";

  if (!isLocalDispatch()) {
    return await runStartRemote(target, json);
  }

  const existing = keepAlive.readKeepAlivePid();
  if (existing !== null) {
    const msg = `keep-alive already running (pid=${String(existing)})`;
    if (json) process.stdout.write(`${JSON.stringify({ error: msg, pid: existing }, null, 2)}\n`);
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Spawn this same CLI as a detached worker. Use `process.execPath`
  // (bun) + argv[1] (bin.ts) so whether the user launched via shim or
  // `bun packages/cli/src/bin.ts`, the supervisor picks up the same
  // entry point.
  const bin = process.execPath;
  const entry = process.argv[1];
  if (!entry) {
    process.stderr.write("Cannot determine bin path for supervisor\n");
    return 1;
  }
  const child = spawn(bin, [entry, "keep-alive", "worker", target], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const pid = await waitForSupervisorPid();
  return reportStartResult(pid, target, json);
}

interface StopFlags {
  json: boolean;
  graceSeconds: number;
  name: string | undefined;
}

type StopArgStep = { next: number } | { exit: number };

function applyStopNameFlag(
  arg: string,
  args: string[],
  i: number,
  flags: StopFlags,
): StopArgStep | null {
  if (arg === "--name") {
    flags.name = args[i + 1];
    if (!flags.name) {
      process.stderr.write("keep-alive stop: --name requires a value\n");
      return { exit: 1 };
    }
    return { next: i + 2 };
  }
  if (arg.startsWith("--name=")) {
    flags.name = arg.slice("--name=".length);
    if (!flags.name) {
      process.stderr.write("keep-alive stop: --name requires a value\n");
      return { exit: 1 };
    }
    return { next: i + 1 };
  }
  return null;
}

function applyStopArg(args: string[], i: number, flags: StopFlags): StopArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { next: i + 1 };
  }
  if (arg.startsWith("--grace=")) {
    const n = Number.parseInt(arg.slice("--grace=".length), 10);
    if (Number.isFinite(n) && n > 0) flags.graceSeconds = n;
    return { next: i + 1 };
  }
  const nameStep = applyStopNameFlag(arg, args, i, flags);
  if (nameStep !== null) return nameStep;
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`Unknown flag: ${arg}\n`);
    return { exit: 1 };
  }
  return { next: i + 1 };
}

async function executeStop(
  workload: string,
  graceSeconds: number,
): Promise<Awaited<ReturnType<typeof keepAlive.stopKeepAlive>> | null> {
  if (isLocalDispatch()) {
    return await keepAlive.stopKeepAlive({ key: { name: workload }, graceSeconds });
  }
  try {
    return await getNodeClient().keepAliveStop.mutate({
      workload,
      graceSeconds,
    });
  } catch (err) {
    process.stderr.write(
      `keep-alive stop: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

async function runStop(args: string[]): Promise<number> {
  const flags: StopFlags = { json: false, graceSeconds: 10, name: undefined };
  let i = 0;
  while (i < args.length) {
    const step = applyStopArg(args, i, flags);
    if ("exit" in step) return step.exit;
    i = step.next;
  }

  let workload: string;
  try {
    workload = resolveWorkloadName(flags.name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`keep-alive stop: ${(err as Error).message}\n`);
    return 1;
  }

  const result = await executeStop(workload, flags.graceSeconds);
  if (result === null) return 1;

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `stopped pid=${String(result.pid ?? "none")}${result.killed ? " (SIGTERM)" : ""}\n`,
    );
  }
  return 0;
}

async function fetchKeepAliveStatus(): Promise<ReturnType<
  typeof keepAlive.keepAliveStatus
> | null> {
  if (isLocalDispatch()) {
    return keepAlive.keepAliveStatus();
  }
  try {
    return await getNodeClient().keepAliveStatus.query();
  } catch (err) {
    process.stderr.write(
      `keep-alive status: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function printStatusHuman(status: ReturnType<typeof keepAlive.keepAliveStatus>): number {
  process.stdout.write(
    `keep-alive: ${status.running ? `running (pid=${String(status.pid)})` : "stopped"}\n`,
  );
  if (status.state) {
    for (const [k, v] of Object.entries(status.state)) {
      process.stdout.write(`  ${k}=${String(v)}\n`);
    }
  }
  return status.running ? 0 : 1;
}

async function runStatus(args: string[]): Promise<number> {
  const parsed = parseJsonPositionalArgs(args);
  if ("exit" in parsed) return parsed.exit;

  const status = await fetchKeepAliveStatus();
  if (status === null) return 1;

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.running ? 0 : 1;
  }
  return printStatusHuman(status);
}

function parsePositiveInt(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

interface WorkerArgs {
  positional: string[];
  intervalSeconds: number | undefined;
  maxBackoff: number | undefined;
}

function parseWorkerArgs(args: string[]): WorkerArgs | { exit: number } {
  const positional: string[] = [];
  let intervalSeconds: number | undefined;
  let maxBackoff: number | undefined;
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return { exit: 0 };
    } else if (arg.startsWith("--interval=")) {
      intervalSeconds = parsePositiveInt(arg.slice("--interval=".length)) ?? intervalSeconds;
    } else if (arg.startsWith("--max-backoff=")) {
      maxBackoff = parsePositiveInt(arg.slice("--max-backoff=".length)) ?? maxBackoff;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return { exit: 1 };
    } else positional.push(arg);
  }
  return { positional, intervalSeconds, maxBackoff };
}

async function runWorker(args: string[]): Promise<number> {
  const parsed = parseWorkerArgs(args);
  if ("exit" in parsed) return parsed.exit;
  const { intervalSeconds, maxBackoff } = parsed;
  const target = parsed.positional[0] ?? "current";

  // Wire SIGTERM to a trip the abort signal so the loop exits cleanly
  // (allowing the `finally` cleanup to stop llama-server).
  const controller = new AbortController();
  const onSignal = (): void => {
    controller.abort();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    await keepAlive.runKeepAliveWorker({
      key: { name: target },
      target,
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      ...(maxBackoff !== undefined ? { maxBackoff } : {}),
      signal: controller.signal,
    });
    return 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

export async function runKeepAlive(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      return await runStart(rest);
    case "stop":
      return await runStop(rest);
    case "status":
      return await runStatus(rest);
    case "worker":
      return await runWorker(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown keep-alive subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
