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

function parseStartFlags(args: string[]): StartFlags | { error: string } | { help: true } {
  const positional: string[] = [];
  const extra: string[] = [];
  let json = false;
  let skipTuned = false;
  let timeoutSeconds = 60;
  let sawDashDash = false;
  let workloadExplicit: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = required(args[i]);
    if (sawDashDash) {
      extra.push(arg);
      continue;
    }
    if (arg === "--") {
      sawDashDash = true;
      continue;
    } else if (arg === "--json") {
      json = true;
      continue;
    } else if (arg === "--no-tuned") {
      skipTuned = true;
      continue;
    } else if (arg.startsWith("--timeout=")) {
      const n = Number.parseInt(arg.slice("--timeout=".length), 10);
      if (Number.isFinite(n) && n > 0) timeoutSeconds = n;
      continue;
    } else if (arg === "--name") {
      workloadExplicit = args[i + 1];
      if (!workloadExplicit) {
        return { error: "server start: --name requires a value" };
      }
      i += 1;
      continue;
    } else if (arg.startsWith("--name=")) {
      workloadExplicit = arg.slice("--name=".length);
      if (!workloadExplicit) {
        return { error: "server start: --name requires a value" };
      }
      continue;
    } else if (arg === "-h" || arg === "--help") {
      return { help: true };
    } else if (arg.startsWith("--")) {
      return { error: `Unknown flag: ${arg}` };
    } else {
      positional.push(arg);
    }
  }
  const target = positional[0] ?? "current";
  if (positional.length > 1) {
    return {
      error: `Extra positional args need to follow \`--\`: ${positional.slice(1).join(" ")}`,
    };
  }
  return { target, extra, json, skipTuned, timeoutSeconds, workloadExplicit };
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
  const workload = resolveWorkloadName(parsed.workloadExplicit, resolved, {
    synthesizeIfEmpty: true,
  });

  const workloadKind: "rel" | "alias" =
    parsed.target.includes("/") || parsed.target.endsWith(".gguf") ? "rel" : "alias";
  const manifest: workloadSchema.ModelRun = {
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
  workloadStore.saveWorkload(manifest);

  let result: Awaited<ReturnType<typeof server.startServer>>;
  if (isLocalDispatch()) {
    result = await server.startServer({
      key: { name: workload },
      target: parsed.target,
      extraArgs: parsed.extra,
      timeoutSeconds: parsed.timeoutSeconds,
      skipTuned: parsed.skipTuned,
      onEvent: forwardEvent,
      resolved,
    });
  } else {
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
      result = await subscribeRemote<
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
      return 1;
    }
  }

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`${result.error ?? "server failed to start"}\n`);
  } else {
    process.stdout.write(
      `llama-server up pid=${String(result.pid)} endpoint=${result.endpoint}${result.tunedProfile ? ` tuned=${result.tunedProfile}` : ""}${result.retried ? " (retried)" : ""}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

async function runStop(args: string[]): Promise<number> {
  let json = false;
  let graceSeconds = 5;
  let name: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = required(args[i]);
    if (arg === "--json") json = true;
    else if (arg.startsWith("--grace=")) {
      const n = Number.parseInt(arg.slice("--grace=".length), 10);
      if (Number.isFinite(n) && n > 0) graceSeconds = n;
    } else if (arg === "--name") {
      name = args[i + 1];
      if (!name) {
        process.stderr.write("server stop: --name requires a value\n");
        return 1;
      }
      i += 1;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      if (!name) {
        process.stderr.write("server stop: --name requires a value\n");
        return 1;
      }
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  let workload: string;
  try {
    workload = resolveWorkloadName(name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server stop: ${(err as Error).message}\n`);
    return 1;
  }
  let result: Awaited<ReturnType<typeof server.stopServer>>;
  if (isLocalDispatch()) {
    result = await server.stopServer({ key: { name: workload }, graceSeconds });
  } else {
    try {
      result = await getNodeClient().serverStop.mutate({
        workload,
        graceSeconds,
      });
    } catch (err) {
      process.stderr.write(
        `server stop: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `stopped pid=${String(result.pid ?? "none")}${result.killed ? " (SIGKILL)" : ""}\n`,
    );
  }
  return 0;
}

async function runStatus(args: string[]): Promise<number> {
  let json = false;
  let name: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = required(args[i]);
    if (arg === "--json") json = true;
    else if (arg === "--name") {
      name = args[i + 1];
      if (!name) {
        process.stderr.write("server status: --name requires a value\n");
        return 1;
      }
      i += 1;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      if (!name) {
        process.stderr.write("server status: --name requires a value\n");
        return 1;
      }
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  let status: Awaited<ReturnType<typeof server.serverStatus>>;
  let workload: string;
  try {
    workload = resolveWorkloadName(name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server status: ${(err as Error).message}\n`);
    return 1;
  }
  if (isLocalDispatch()) {
    status = await server.serverStatus({ name: workload }, envMod.resolveEnv());
  } else {
    try {
      status = await getNodeClient().serverStatus.query({ workload });
    } catch (err) {
      process.stderr.write(
        `server status: remote call to '${getGlobals().nodeName ?? ""}' failed: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.state === "up" ? 0 : 1;
  }
  const lines: string[] = [`state=${status.state}`, `endpoint=${status.endpoint}`];
  if (status.advertisedEndpoint && status.advertisedEndpoint !== status.endpoint) {
    lines.push(`advertised=${status.advertisedEndpoint}`);
  }
  lines.push(`pid=${String(status.pid ?? "none")}`);
  lines.push(`http=${String(status.health.httpCode ?? "unreachable")}`);
  if (status.rel) lines.push(`rel=${status.rel}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
  return status.state === "up" ? 0 : 1;
}

async function runLogs(args: string[]): Promise<number> {
  let lines = 50;
  let follow = false;
  let name: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = required(args[i]);
    if (arg === "--follow" || arg === "-f") follow = true;
    else if (arg === "--name") {
      name = args[i + 1];
      if (!name) {
        process.stderr.write("server logs: --name requires a value\n");
        return 1;
      }
      i += 1;
    } else if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      if (!name) {
        process.stderr.write("server logs: --name requires a value\n");
        return 1;
      }
    } else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith("--lines=")) {
      const n = Number.parseInt(arg.slice("--lines=".length), 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`server logs: invalid --lines: ${arg}\n`);
        return 1;
      }
      lines = n;
    } else if (arg.startsWith("--")) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }

  let workload: string;
  try {
    workload = resolveWorkloadName(name, envMod.resolveEnv());
  } catch (err) {
    process.stderr.write(`server logs: ${(err as Error).message}\n`);
    return 1;
  }

  const onLine = (e: serverLogsMod.LogLineEvent): void => {
    process.stdout.write(`${e.line}\n`);
  };

  if (isLocalDispatch()) {
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
