import { catalog, env as envMod, keepAlive, server, target as targetMod } from "@llamactl/core";
import {
  defaultResidencyStorePath,
  type DirectLifecycleOpts,
  directWorkloadProvenDown,
  exclusiveGroupLaunchRefusal,
  runDirectResidencyStart,
  runDirectResidencyStop,
} from "@llamactl/remote";
import { spawn } from "node:child_process";

import {
  getGlobals,
  getNodeClient,
  isLocalDispatch,
  resolveEffectiveNodeName,
} from "../dispatcher.js";
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
      If the supervisor PID verifies, write its stop file, wait up to
      <grace> seconds (default 10), SIGTERM it only if a final check
      still verifies it, and run the llama-server stop as a safety net;
      that result is not reported. If its PID cannot be verified at the
      first check or at the re-check right after the grace period,
      nothing is signalled, stop does not remove its tracking files, and
      --json reports stopped: false. If only the final check fails, the
      supervisor is not signalled, but the safety net still runs, both
      files are removed, and --json reports stopped: true.

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

/**
 * Refusal message when the recorded supervisor pid blocks a fresh start;
 * null when start may proceed. "unknown" must not read as absent — a
 * second supervisor would compete with a process we cannot rule out as
 * ours. Only provably-gone records (dead/reused) fall through.
 */
function duplicateStartRefusal(): { msg: string; pid: number } | null {
  const existing = keepAlive.readKeepAliveRecord();
  if (existing.pid === null || existing.verdict === null) return null;
  if (existing.verdict === "dead" || existing.verdict === "reused") return null;
  const msg =
    existing.verdict === "alive"
      ? `keep-alive already running (pid=${String(existing.pid)})`
      : `pid identity unknown for recorded keep-alive pid ${String(existing.pid)} — refusing to start a duplicate`;
  return { msg, pid: existing.pid };
}

/**
 * Read-only exclusive-group gate for a resolved catalog rel (#517). Reads the rel's
 * `residencyGroup` and delegates to `exclusiveGroupLaunchRefusal` with the local store, using the
 * rel as the refusal id. Returns null when the launch may proceed. `runStart` calls it before the
 * detached spawn with the target resolved by `resolveTarget`; the worker passes it as `beforeStart`,
 * which receives the rel the loop already resolved. `ignoreModel` names the caller's own workload
 * (the keep-alive target) so its recorded row never refuses its own restart. A node with no store
 * file launches as before.
 */
function keepAliveLaunchRefusal(rel: string, ignoreModel?: string): string | null {
  const entry = catalog.findByRel(rel);
  if (!entry) return null;
  return exclusiveGroupLaunchRefusal({
    id: rel,
    group: entry.residencyGroup,
    storePath: defaultResidencyStorePath(),
    ...(ignoreModel !== undefined ? { ignoreModel } : {}),
  });
}

// The lifecycle opts the worker's recorded start/stop run under (#517): the
// local store, the group of the resolved catalog rel, and the same proven-down
// and running predicates the agent's direct ModelRun procedures use.
function keepAliveLifecycleOpts(group: string | undefined): DirectLifecycleOpts {
  return {
    storePath: defaultResidencyStorePath(),
    group,
    isProvenDown: directWorkloadProvenDown,
    isRunning: (model) => server.readServerPid({ name: model }) !== null,
    log: (line): void => {
      process.stderr.write(line);
    },
  };
}

/**
 * The worker's engine start with its `residency_states` row recorded (#517). The
 * row is keyed by the workload name — the `<target>` as given — and grouped by
 * the catalog row of the rel being started, so a failed start leaves it `failed`
 * with that group. A walk that refuses before the dep returns its detail as the
 * start error, so the worker takes its unchanged start-failed path.
 */
async function keepAliveRecordedStart(
  o: server.StartServerOptions,
): Promise<server.StartServerResult> {
  const outcome = await runDirectResidencyStart(
    o.key.name,
    () => server.startServer(o),
    keepAliveLifecycleOpts(catalog.findByRel(o.target)?.residencyGroup),
  );
  if (outcome.ran) {
    return outcome.result;
  }
  return {
    ok: false,
    pid: null,
    endpoint: "",
    advertisedEndpoint: "",
    tunedProfile: null,
    retried: false,
    error: outcome.detail,
  };
}

/**
 * The worker-exit stop with its `residency_states` row recorded (#517): only a
 * confirmed stop walks the row down to `downloaded`, so an unconfirmed one keeps
 * the group held exactly as a direct ModelRun stop does.
 */
async function keepAliveRecordedStop(
  o: server.StopServerOptions,
): Promise<server.StopServerResult> {
  const outcome = await runDirectResidencyStop(
    o.key.name,
    async () => {
      const s = await server.stopServer(o);
      return {
        ok: s.stopped,
        ...(s.stopped ? {} : { error: "stop did not confirm process removal" }),
        stop: s,
      };
    },
    keepAliveLifecycleOpts(undefined),
  );
  return outcome.ran ? outcome.result.stop : { stopped: false, pid: null, killed: false };
}

async function runStart(args: string[]): Promise<number> {
  const parsed = parseJsonPositionalArgs(args);
  if ("exit" in parsed) return parsed.exit;
  const json = parsed.json;
  const target = parsed.positional[0] ?? "current";

  if (!isLocalDispatch()) {
    return await runStartRemote(target, json);
  }

  const refusal = duplicateStartRefusal();
  if (refusal !== null) {
    if (json)
      process.stdout.write(
        `${JSON.stringify({ error: refusal.msg, pid: refusal.pid }, null, 2)}\n`,
      );
    else process.stderr.write(`${refusal.msg}\n`);
    return 1;
  }

  // Gate on the resolved rel, as the worker does. An unresolvable target
  // skips the gate and spawns as before; the worker records resolve-failed.
  const resolvedRel = targetMod.resolveTarget(target);
  const groupRefusal = resolvedRel === null ? null : keepAliveLaunchRefusal(resolvedRel, target);
  if (groupRefusal !== null) {
    process.stderr.write(`keep-alive start: ${groupRefusal}\n`);
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

// The keepAliveStop procedure caps graceSeconds at MAX_GRACE_SECONDS; reject
// anything outside 1..MAX here so the user gets a clear error before any
// dispatch instead of a raw schema dump and a supervisor left running.
const MAX_GRACE_SECONDS = 60;
const GRACE_RANGE_ERROR = `keep-alive stop: --grace must be between 1 and ${String(MAX_GRACE_SECONDS)}`;

function applyStopArg(args: string[], i: number, flags: StopFlags): StopArgStep {
  const arg = required(args[i]);
  if (arg === "--json") {
    flags.json = true;
    return { next: i + 1 };
  }
  if (arg.startsWith("--grace=")) {
    const n = Number.parseInt(arg.slice("--grace=".length), 10);
    if (Number.isFinite(n) && n > 0) {
      if (n > MAX_GRACE_SECONDS) {
        process.stderr.write(`${GRACE_RANGE_ERROR}\n`);
        return { exit: 1 };
      }
      flags.graceSeconds = n;
    }
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

// Mirrors dispatchFailureLabel in the server command: local dispatch carries no
// --node flag, so name the in-process node 'local' and drop 'remote' from its
// failures, which never left this process.
function dispatchFailureLabel(): string {
  const nodeName = getGlobals().nodeName;
  if (isLocalDispatch()) return `call to '${nodeName ?? "local"}'`;
  return `remote call to '${nodeName ?? ""}'`;
}

async function executeStop(
  workload: string,
  graceSeconds: number,
): Promise<Awaited<ReturnType<typeof keepAlive.stopKeepAlive>> | null> {
  // #520: dispatch goes through the keepAliveStop procedure on remote and
  // local runs alike; for a local node that is the in-process router caller, so
  // the node stop fence sees the stop exactly like `llamactl server stop`.
  try {
    return await getNodeClient().keepAliveStop.mutate({
      workload,
      graceSeconds,
    });
  } catch (err) {
    process.stderr.write(
      `keep-alive stop: ${dispatchFailureLabel()} failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

// #520: mirrors stopRefusalLine in the server command — the node stop fence
// reports which registry refused and the ids that were active.
function keepAliveStopRefusalLine(
  node: string,
  workload: string,
  refused: { reason: string; active: readonly string[] },
): string {
  return `keep-alive stop: node ${node} refused to stop ${workload} (${refused.reason}${refused.active.length > 0 ? `: ${refused.active.join(", ")}` : ""}); nothing was stopped\n`;
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
    return result.refused !== undefined ? 1 : 0;
  }
  if (result.refused !== undefined) {
    process.stderr.write(
      keepAliveStopRefusalLine(resolveEffectiveNodeName(), workload, result.refused),
    );
    return 1;
  }
  process.stdout.write(
    `stopped pid=${String(result.pid ?? "none")}${result.killed ? " (SIGTERM)" : ""}\n`,
  );
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
      beforeStart: (rel) => keepAliveLaunchRefusal(rel, target),
      start: keepAliveRecordedStart,
      stop: keepAliveRecordedStop,
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
