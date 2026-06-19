import { env as envMod, server, serverLogs as serverLogsMod } from "@llamactl/core";
import { type workloadSchema, workloadStore } from "@llamactl/remote";

import {
  getGlobals,
  getNodeClient,
  isLocalDispatch,
  matchDoneEvent,
  resolveEffectiveNodeName,
  subscribeRemote,
} from "../dispatcher.js";
import { required } from "../required.js";
import { resolveWorkloadName } from "./_workload-resolve.js";

const USAGE = `Usage: llamactl server <subcommand>

Subcommands:
  start <target> [--name <workload>] [--timeout=<s>] [--no-tuned] [--json] [-- extra-args]
      Launch llama-server in the background with the tuned profile
      args (when available), wait for /health=200 up to <timeout>
      seconds (default 60), and record the PID. Everything after \`--\`
      is forwarded to llama-server as-is.

  stop [--name <workload>] [--grace=<s>] [--json]
      SIGTERM the tracked llama-server PID and escalate to SIGKILL
      after <grace> seconds (default 5).

  status [--name <workload>] [--json]
      Report whether llama-server is reachable at the configured
      endpoint and what PID (if any) is tracked.

  logs [--name <workload>] [--follow|-f] [--lines=<N>]
      Print the last N lines (default 50) of the server.log file. With
      --follow, keep streaming new lines until Ctrl-C. Against
      --node <remote>, tails the agent's log file over SSE.
`;

function forwardEvent(e: server.ServerEvent): void {
  switch (e.type) {
    case "launch":
      process.stderr.write(`$ ${e.command} ${e.args.join(" ")}\n`);
      process.stderr.write(`launched pid=${String(e.pid)}\n`);
      break;
    case "waiting":
      // Quiet by default — a dot would help but spams stderr. Emit
      // one line every ~10 attempts so the user sees forward progress
      // without drowning in httpCode logs.
      if (e.attempt % 10 === 0) {
        process.stderr.write(
          `waiting ... attempt=${String(e.attempt)} http=${e.httpCode ?? "n/a"}\n`,
        );
      }
      break;
    case "retry":
      process.stderr.write(`retrying: ${e.reason}\n`);
      break;
    case "ready":
      process.stderr.write(`ready pid=${String(e.pid)} endpoint=${e.endpoint}\n`);
      break;
    case "timeout":
      process.stderr.write(`timeout pid=${String(e.pid)}\n`);
      break;
    case "exited":
      process.stderr.write(`exited code=${String(e.code ?? "?")}\n`);
      break;
  }
}

interface StartFlags {
  target: string;
  extra: string[];
  json: boolean;
  skipTuned: boolean;
  timeoutSeconds: number;
  workloadExplicit?: string;
}

/**
 * Shared `--name <value>` / `--name=<value>` handling for the server
 * subcommands. Returns null when `arg` is not a --name flag.
 */
function takeNameFlag(
  args: string[],
  i: number,
  arg: string,
  label: string,
): { name: string; next: number } | { error: string } | null {
  if (arg === "--name") {
    const name = args[i + 1];
    if (!name) return { error: `${label}: --name requires a value` };
    return { name, next: i + 2 };
  }
  if (arg.startsWith("--name=")) {
    const name = arg.slice("--name=".length);
    if (!name) return { error: `${label}: --name requires a value` };
    return { name, next: i + 1 };
  }
  return null;
}

interface StartDraft {
  positional: string[];
  extra: string[];
  json: boolean;
  skipTuned: boolean;
  timeoutSeconds: number;
  sawDashDash: boolean;
  workloadExplicit?: string;
}

function applyStartBooleanFlag(draft: StartDraft, arg: string): boolean {
  if (arg === "--") {
    draft.sawDashDash = true;
    return true;
  }
  if (arg === "--json") {
    draft.json = true;
    return true;
  }
  if (arg === "--no-tuned") {
    draft.skipTuned = true;
    return true;
  }
  return false;
}

function applyStartTimeout(draft: StartDraft, arg: string): void {
  const n = Number.parseInt(arg.slice("--timeout=".length), 10);
  if (Number.isFinite(n) && n > 0) draft.timeoutSeconds = n;
}

function consumeStartArg(
  draft: StartDraft,
  args: string[],
  i: number,
): { next: number } | { error: string } | { help: true } {
  const arg = required(args[i]);
  if (draft.sawDashDash) {
    draft.extra.push(arg);
    return { next: i + 1 };
  }
  if (applyStartBooleanFlag(draft, arg)) return { next: i + 1 };
  if (arg.startsWith("--timeout=")) {
    applyStartTimeout(draft, arg);
    return { next: i + 1 };
  }
  const nameFlag = takeNameFlag(args, i, arg, "server start");
  if (nameFlag) {
    if ("error" in nameFlag) return nameFlag;
    draft.workloadExplicit = nameFlag.name;
    return { next: nameFlag.next };
  }
  if (arg === "-h" || arg === "--help") return { help: true };
  if (arg.startsWith("--")) return { error: `Unknown flag: ${arg}` };
  draft.positional.push(arg);
  return { next: i + 1 };
}

function parseStartFlags(args: string[]): StartFlags | { error: string } | { help: true } {
  const draft: StartDraft = {
    positional: [],
    extra: [],
    json: false,
    skipTuned: false,
    timeoutSeconds: 60,
    sawDashDash: false,
  };
  let i = 0;
  while (i < args.length) {
    const step = consumeStartArg(draft, args, i);
    if ("error" in step) return step;
    if ("help" in step) return step;
    i = step.next;
  }
  const target = draft.positional[0] ?? "current";
  if (draft.positional.length > 1) {
    return {
      error: `Extra positional args need to follow \`--\`: ${draft.positional.slice(1).join(" ")}`,
    };
  }
  return {
    target,
    extra: draft.extra,
    json: draft.json,
    skipTuned: draft.skipTuned,
    timeoutSeconds: draft.timeoutSeconds,
    workloadExplicit: draft.workloadExplicit,
  };
}

function buildStartManifest(
  workload: string,
  node: string,
  parsed: StartFlags,
): workloadSchema.ModelRun {
  const workloadKind: "rel" | "alias" =
    parsed.target.includes("/") || parsed.target.endsWith(".gguf") ? "rel" : "alias";
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: workload, labels: {}, annotations: {} },
    spec: {
      node,
      enabled: true,
      target: { kind: workloadKind, value: parsed.target },
      extraArgs: parsed.extra,
      workers: [],
      restartPolicy: "Always",
      timeoutSeconds: parsed.timeoutSeconds,
      gateway: false,
      allowExternalBind: false,
    },
  };
}

async function fetchStartResult(
  workload: string,
  parsed: StartFlags,
  resolved: ReturnType<typeof envMod.resolveEnv>,
): Promise<Awaited<ReturnType<typeof server.startServer>> | null> {
  if (isLocalDispatch()) {
    return await server.startServer({
      key: { name: workload },
      target: parsed.target,
      extraArgs: parsed.extra,
      timeoutSeconds: parsed.timeoutSeconds,
      skipTuned: parsed.skipTuned,
      onEvent: forwardEvent,
      resolved,
    });
  }
  const input: {
    workload: string;
    target: string;
    extraArgs?: string[];
    timeoutSeconds?: number;
    skipTuned?: boolean;
  } = {
    workload,
    target: parsed.target,
  };
  try {
    if (parsed.extra.length > 0) input.extraArgs = parsed.extra;
    if (parsed.timeoutSeconds !== 60) input.timeoutSeconds = parsed.timeoutSeconds;
    if (parsed.skipTuned) input.skipTuned = parsed.skipTuned;
    return await subscribeRemote<
      server.ServerEvent,
      Awaited<ReturnType<typeof server.startServer>>
    >({
      subscribe: (handlers) => getNodeClient().serverStart.subscribe(input, handlers),
      onEvent: forwardEvent,
      extractDone: matchDoneEvent<Awaited<ReturnType<typeof server.startServer>>>("done"),
    });
  } catch (err) {
    process.stderr.write(
      `server start: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function renderStartResult(
  result: Awaited<ReturnType<typeof server.startServer>>,
  json: boolean,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`${result.error ?? "server failed to start"}\n`);
  } else {
    process.stdout.write(
      `llama-server up pid=${String(result.pid)} endpoint=${result.endpoint}${result.tunedProfile ? ` tuned=${result.tunedProfile}` : ""}${result.retried ? " (retried)" : ""}\n`,
    );
  }
}

async function runStart(args: string[]): Promise<number> {
  const parsed = parseStartFlags(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return 0;
  }

  const resolved = envMod.resolveEnv();
  const node = resolveEffectiveNodeName();
  let workload: string;
  try {
    workload = resolveWorkloadName(parsed.workloadExplicit, resolved, {
      synthesizeIfEmpty: true,
    });
  } catch (err) {
    process.stderr.write(`server start: ${(err as Error).message}\n`);
    return 1;
  }

  workloadStore.saveWorkload(buildStartManifest(workload, node, parsed));

  const result = await fetchStartResult(workload, parsed, resolved);
  if (!result) return 1;

  renderStartResult(result, parsed.json);
  return result.ok ? 0 : 1;
}

function applyGraceFlag(draft: { graceSeconds: number }, arg: string): void {
  const n = Number.parseInt(arg.slice("--grace=".length), 10);
  if (Number.isFinite(n) && n > 0) draft.graceSeconds = n;
}

function consumeStopArg(
  draft: { json: boolean; graceSeconds: number; name?: string },
  args: string[],
  i: number,
): { next: number } | { exit: number } {
  const arg = required(args[i]);
  if (arg === "--json") {
    draft.json = true;
    return { next: i + 1 };
  }
  if (arg.startsWith("--grace=")) {
    applyGraceFlag(draft, arg);
    return { next: i + 1 };
  }
  const nameFlag = takeNameFlag(args, i, arg, "server stop");
  if (nameFlag) {
    if ("error" in nameFlag) {
      process.stderr.write(`${nameFlag.error}\n`);
      return { exit: 1 };
    }
    draft.name = nameFlag.name;
    return { next: nameFlag.next };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`Unknown flag: ${arg}\n`);
    return { exit: 1 };
  }
  process.stderr.write(`Unexpected argument '${arg}'; use --name <workload>\n`);
  return { exit: 1 };
}

async function fetchStopResult(
  workload: string,
  graceSeconds: number,
): Promise<Awaited<ReturnType<typeof server.stopServer>> | null> {
  if (isLocalDispatch()) {
    return await server.stopServer({ key: { name: workload }, graceSeconds });
  }
  try {
    return await getNodeClient().serverStop.mutate({
      workload,
      graceSeconds,
    });
  } catch (err) {
    process.stderr.write(
      `server stop: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

async function runStop(args: string[]): Promise<number> {
  const draft: { json: boolean; graceSeconds: number; name?: string } = {
    json: false,
    graceSeconds: 5,
  };
  let i = 0;
  while (i < args.length) {
    const step = consumeStopArg(draft, args, i);
    if ("exit" in step) return step.exit;
    i = step.next;
  }
  let workload: string;
  try {
    workload = resolveWorkloadName(draft.name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server stop: ${(err as Error).message}\n`);
    return 1;
  }
  const result = await fetchStopResult(workload, draft.graceSeconds);
  if (!result) return 1;
  if (draft.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `stopped pid=${String(result.pid ?? "none")}${result.killed ? " (SIGKILL)" : ""}\n`,
    );
  }
  return 0;
}

function consumeStatusArg(
  draft: { json: boolean; name?: string },
  args: string[],
  i: number,
): { next: number } | { exit: number } {
  const arg = required(args[i]);
  if (arg === "--json") {
    draft.json = true;
    return { next: i + 1 };
  }
  const nameFlag = takeNameFlag(args, i, arg, "server status");
  if (nameFlag) {
    if ("error" in nameFlag) {
      process.stderr.write(`${nameFlag.error}\n`);
      return { exit: 1 };
    }
    draft.name = nameFlag.name;
    return { next: nameFlag.next };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`Unknown flag: ${arg}\n`);
    return { exit: 1 };
  }
  process.stderr.write(`Unexpected argument '${arg}'; use --name <workload>\n`);
  return { exit: 1 };
}

async function fetchServerStatus(
  workload: string,
): Promise<Awaited<ReturnType<typeof server.serverStatus>> | null> {
  if (isLocalDispatch()) {
    return await server.serverStatus({ name: workload }, envMod.resolveEnv());
  }
  try {
    return await getNodeClient().serverStatus.query({ workload });
  } catch (err) {
    process.stderr.write(
      `server status: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function renderStatusText(status: Awaited<ReturnType<typeof server.serverStatus>>): void {
  const lines: string[] = [`state=${status.state}`, `endpoint=${status.endpoint}`];
  if (status.advertisedEndpoint && status.advertisedEndpoint !== status.endpoint) {
    lines.push(`advertised=${status.advertisedEndpoint}`);
  }
  lines.push(`pid=${String(status.pid ?? "none")}`);
  lines.push(`http=${String(status.health.httpCode ?? "unreachable")}`);
  if (status.rel) lines.push(`rel=${status.rel}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

async function runStatus(args: string[]): Promise<number> {
  const draft: { json: boolean; name?: string } = { json: false };
  let i = 0;
  while (i < args.length) {
    const step = consumeStatusArg(draft, args, i);
    if ("exit" in step) return step.exit;
    i = step.next;
  }
  let workload: string;
  try {
    workload = resolveWorkloadName(draft.name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server status: ${(err as Error).message}\n`);
    return 1;
  }
  const status = await fetchServerStatus(workload);
  if (!status) return 1;
  if (draft.json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.state === "up" ? 0 : 1;
  }
  renderStatusText(status);
  return status.state === "up" ? 0 : 1;
}

function applyLinesFlag(draft: { lines: number }, arg: string): { exit: number } | null {
  const n = Number.parseInt(arg.slice("--lines=".length), 10);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(`server logs: invalid --lines: ${arg}\n`);
    return { exit: 1 };
  }
  draft.lines = n;
  return null;
}

function consumeServerLogsArg(
  draft: { lines: number; follow: boolean; name?: string },
  args: string[],
  i: number,
): { next: number } | { exit: number } {
  const arg = required(args[i]);
  if (arg === "--follow" || arg === "-f") {
    draft.follow = true;
    return { next: i + 1 };
  }
  const nameFlag = takeNameFlag(args, i, arg, "server logs");
  if (nameFlag) {
    if ("error" in nameFlag) {
      process.stderr.write(`${nameFlag.error}\n`);
      return { exit: 1 };
    }
    draft.name = nameFlag.name;
    return { next: nameFlag.next };
  }
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(USAGE);
    return { exit: 0 };
  }
  if (arg.startsWith("--lines=")) {
    return applyLinesFlag(draft, arg) ?? { next: i + 1 };
  }
  if (arg.startsWith("--")) {
    process.stderr.write(`Unknown flag: ${arg}\n`);
    return { exit: 1 };
  }
  process.stderr.write(`Unexpected argument '${arg}'; use --name <workload>\n`);
  return { exit: 1 };
}

async function tailLocalLogs(
  workload: string,
  lines: number,
  follow: boolean,
  onLine: (e: serverLogsMod.LogLineEvent) => void,
): Promise<number> {
  const ac = new AbortController();
  const abort = (): void => {
    ac.abort();
  };
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await serverLogsMod.tailServerLog({
      key: { name: workload },
      lines,
      follow,
      signal: ac.signal,
      onLine,
    });
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  return 0;
}

// Remote path. serverLogs has no terminal `done` event; a normal
// completion means the subscription closed cleanly (backfill drained
// in non-follow mode, or user-initiated abort in follow mode).
async function tailRemoteLogs(
  workload: string,
  lines: number,
  follow: boolean,
  onLine: (e: serverLogsMod.LogLineEvent) => void,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const sub = getNodeClient().serverLogs.subscribe(
      { workload, lines, follow },
      {
        onData: (e: unknown) => {
          const evt = e as serverLogsMod.LogLineEvent;
          onLine(evt);
        },
        onError: (err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
        onComplete: () => {
          cleanup();
          resolve();
        },
      },
    );
    const abort = (): void => {
      sub.unsubscribe();
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    };
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
    // eslint-disable-next-line @typescript-eslint/use-unknown-in-catch-callback-variable -- Preserve existing CLI/test semantics while clearing strict lint debt.
  }).catch((err: Error) => {
    process.stderr.write(
      `server logs: remote call to '${getGlobals().nodeName ?? ""}' failed: ${err.message}\n`,
    );
    return 1;
  });
  return 0;
}

async function runLogs(args: string[]): Promise<number> {
  const draft: { lines: number; follow: boolean; name?: string } = { lines: 50, follow: false };
  let i = 0;
  while (i < args.length) {
    const step = consumeServerLogsArg(draft, args, i);
    if ("exit" in step) return step.exit;
    i = step.next;
  }

  let workload: string;
  try {
    workload = resolveWorkloadName(draft.name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server logs: ${(err as Error).message}\n`);
    return 1;
  }

  const onLine = (e: serverLogsMod.LogLineEvent): void => {
    process.stdout.write(`${e.line}\n`);
  };

  if (isLocalDispatch()) {
    return await tailLocalLogs(workload, draft.lines, draft.follow, onLine);
  }
  return await tailRemoteLogs(workload, draft.lines, draft.follow, onLine);
}

export async function runServer(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "start":
      return await runStart(rest);
    case "stop":
      return await runStop(rest);
    case "status":
      return await runStatus(rest);
    case "logs":
      return await runLogs(rest);
    case undefined:
    case "-h":
    case "--help":
    case "help":
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown server subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
