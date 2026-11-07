import type { router } from "@llamactl/remote";

import { getGlobals } from "../dispatcher.js";

/**
 * `llamactl bench schedule` — the CLI counterpart of the control-plane
 * bench scheduler that Electron main used to host exclusively. CRUD and
 * the foreground loop host both drive the existing router procedures
 * through an in-proc `createCaller`; the store and the tick loop stay in
 * `@llamactl/remote`.
 */

type BenchScheduleCaller = Pick<
  ReturnType<typeof router.createCaller>,
  | "benchScheduleList"
  | "benchScheduleAdd"
  | "benchScheduleRemove"
  | "benchScheduleToggle"
  | "benchSchedulerStatus"
  | "benchSchedulerStart"
  | "benchSchedulerStop"
  | "benchSchedulerKick"
>;

type ScheduleRow = Awaited<ReturnType<BenchScheduleCaller["benchScheduleList"]>>[number];
type LoopStatus = Awaited<ReturnType<BenchScheduleCaller["benchSchedulerStatus"]>>;
type RecentEntry = LoopStatus["recent"][number];

export interface BenchScheduleTestSeams {
  caller?: BenchScheduleCaller;
  waitForShutdown?: () => Promise<NodeJS.Signals>;
  sleep?: (ms: number) => Promise<void>;
}

let seams: BenchScheduleTestSeams = {};

export function __setBenchScheduleTestSeams(next: BenchScheduleTestSeams): void {
  seams = { ...next };
}

export function __resetBenchScheduleTestSeams(): void {
  seams = {};
}

const USAGE = `llamactl bench schedule — recurring benches on the control plane

USAGE:
  llamactl bench schedule list [--json]
  llamactl bench schedule add <id> --node <node> --rel <rel>
      [--mode auto|text|vision] --every <duration>
  llamactl bench schedule rm <id>
  llamactl bench schedule toggle <id> on|off
  llamactl bench schedule status [--json]
  llamactl bench schedule kick
  llamactl bench schedule run [--interval=<seconds>]

Schedules live in the control plane's store and fire bench-preset runs on
their target node. The tick loop is opt-in and only runs while
\`llamactl bench schedule run\` is alive — start that under launchd/systemd
to keep schedules firing. \`start\` and \`stop\` are not daemon controls:
stop the loop with Ctrl-C or SIGTERM.

SUBCOMMANDS:
  list      Print every schedule (id, node, rel, mode, every, state,
            last run, last error). --json emits the raw array.
  add       Register a schedule. The target node comes from the global
            --node flag (--node <node> / -n <node>) and is required.
            --every takes a positive integer with an optional s, m, h or
            d suffix (e.g. 90m, 6h, 1d).
  rm        Remove a schedule by id.
  toggle    Enable or disable a schedule: \`toggle <id> on|off\`.
  status    The schedules plus this process's loop state (running, tick
             interval, last/next tick, in-flight, recent runs).
             --json emits { schedules, loop }.
  kick      Run one tick now and print what fired; exits 1 when any
             scheduled bench failed. Refused while another live process
             (a \`bench schedule run\`) holds the run lock.
  run       Foreground loop host: takes the run lock, starts the tick
             loop, stays alive until SIGINT/SIGTERM, drains an in-flight
             bench, then exits. --interval is the tick interval in
             seconds (30-3600, default 60).
             STOP LATENCY: a stop signal finishes the bench in flight
             and starts no further due schedules, so the worst-case
             stop time is one bench timeout (15 minutes). Set your
             launchd/systemd stop timeout accordingly.

Schedules resolve their node from the current config when they fire, so
--context and --cluster-config are not supported here.
`;

type KnownSub = "add" | "kick" | "list" | "rm" | "run" | "start" | "status" | "stop" | "toggle";

const KNOWN_SUBS: readonly KnownSub[] = [
  "add",
  "kick",
  "list",
  "rm",
  "run",
  "start",
  "status",
  "stop",
  "toggle",
];

function isKnownSub(sub: string): sub is KnownSub {
  return (KNOWN_SUBS as readonly string[]).includes(sub);
}

const LOOP_CONTROL_REFUSAL =
  "the bench scheduler loop lives in the process that runs it: use " +
  "`llamactl bench schedule run` (foreground; stop it with Ctrl-C or " +
  "SIGTERM, e.g. under launchd/systemd)";

function resolveCaller(): Promise<BenchScheduleCaller> {
  if (seams.caller) return Promise.resolve(seams.caller);
  return import("@llamactl/remote").then(({ router: remoteRouter }) =>
    remoteRouter.createCaller({}),
  );
}

function waitForShutdown(): Promise<NodeJS.Signals> {
  if (seams.waitForShutdown) return seams.waitForShutdown();
  return new Promise<NodeJS.Signals>((resolve) => {
    const onSignal = (signal: NodeJS.Signals): void => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolve(signal);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });
}

function sleep(ms: number): Promise<void> {
  if (seams.sleep) return seams.sleep(ms);
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function refuseUnsupportedGlobals(sub: string): string | null {
  const globals = getGlobals();
  if (globals.contextName) {
    return (
      "bench schedule: --context is not supported; schedules are stored on " +
      "the control plane and resolve their node from the current config when " +
      "they fire\n"
    );
  }
  if (globals.configPath) {
    return "bench schedule: --cluster-config is not supported; set LLAMACTL_CONFIG instead\n";
  }
  if (globals.nodeName && sub !== "add") {
    return `bench schedule ${sub}: --node is only accepted by \`bench schedule add\`\n`;
  }
  return null;
}

type JsonArgs = { json: boolean } | { bail: number };

function parseJsonArgs(args: string[]): JsonArgs {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return { bail: 0 };
    } else {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return { bail: 1 };
    }
  }
  return { json };
}

function padCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

const ROW_HEADERS: readonly string[] = [
  "ID",
  "NODE",
  "REL",
  "MODE",
  "EVERY",
  "STATE",
  "LAST_RUN",
  "LAST_ERROR",
];

function rowCells(row: ScheduleRow): string[] {
  return [
    row.id,
    row.node,
    row.rel,
    row.mode,
    String(row.intervalSeconds),
    row.enabled ? "enabled" : "disabled",
    row.lastRunAt ?? "-",
    row.lastError ?? "-",
  ];
}

function formatScheduleRows(rows: readonly ScheduleRow[]): string[] {
  if (rows.length === 0) return [];
  const cells = rows.map(rowCells);
  const widths = ROW_HEADERS.map((header, index) =>
    Math.max(header.length, ...cells.map((cell) => (cell[index] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, index) => padCell(value, widths[index] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(ROW_HEADERS), ...cells.map(line)];
}

function formatLoopLine(loop: LoopStatus): string {
  if (!loop.running) {
    return "loop: not running in this process (start it with `llamactl bench schedule run`)";
  }
  const tickSeconds = Math.round(loop.tickIntervalMs / 1000);
  return (
    `loop: running (tick every ${String(tickSeconds)}s, ` +
    `last tick ${loop.lastTickAt ?? "-"}, next tick ${loop.nextTickAt ?? "-"}, ` +
    `inflight: ${loop.inflight ? "yes" : "no"})`
  );
}

function formatRecentEntry(entry: RecentEntry): string {
  const head = `${entry.ts} ${entry.id} ${entry.node} ${entry.ok ? "ok" : "FAIL"}`;
  return entry.message ? `${head} ${entry.message}` : head;
}

async function runList(args: string[]): Promise<number> {
  const parsed = parseJsonArgs(args);
  if ("bail" in parsed) return parsed.bail;
  const schedules = await (await resolveCaller()).benchScheduleList();
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(schedules, null, 2)}\n`);
    return 0;
  }
  if (schedules.length === 0) {
    process.stdout.write("No bench schedules\n");
    return 0;
  }
  for (const line of formatScheduleRows(schedules)) process.stdout.write(`${line}\n`);
  return 0;
}

interface AddArgs {
  positional: string[];
  rel: string | undefined;
  mode: string | undefined;
  every: string | undefined;
}

type AddParse =
  | { kind: "ok"; args: AddArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

const VALUED_ADD_FLAGS: ReadonlySet<string> = new Set(["--every", "--mode", "--rel"]);

function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq >= 0 ? arg.slice(0, eq) : arg;
}

function flagInlineValue(arg: string, queue: string[]): string | undefined {
  const eq = arg.indexOf("=");
  return eq >= 0 ? arg.slice(eq + 1) : queue.shift();
}

function assignAddFlag(args: AddArgs, name: string, value: string): void {
  if (name === "--rel") args.rel = value;
  else if (name === "--mode") args.mode = value;
  else args.every = value;
}

function parseAddArgs(argv: string[]): AddParse {
  const args: AddArgs = { positional: [], rel: undefined, mode: undefined, every: undefined };
  const rest = [...argv];
  let arg = rest.shift();
  while (arg !== undefined) {
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (!arg.startsWith("--")) {
      args.positional.push(arg);
      arg = rest.shift();
      continue;
    }
    const name = flagName(arg);
    if (!VALUED_ADD_FLAGS.has(name)) {
      return { kind: "error", message: `Unknown flag: ${arg}` };
    }
    const value = flagInlineValue(arg, rest);
    if (value === undefined) return { kind: "error", message: `Missing value for ${name}` };
    assignAddFlag(args, name, value);
    arg = rest.shift();
  }
  return { kind: "ok", args };
}

const DURATION_UNITS: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };

function parseDurationSeconds(raw: string): number | null {
  const match = /^(\d+)([smhd]?)$/.exec(raw);
  if (!match) return null;
  const value = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value * (DURATION_UNITS[match[2] ?? "s"] ?? 1);
}

type AddPlan =
  | {
      input: {
        id: string;
        node: string;
        rel: string;
        mode: "auto" | "text" | "vision";
        intervalSeconds: number;
      };
    }
  | { error: string };

function planAddArgs(args: AddArgs): AddPlan {
  const id = args.positional[0];
  if (!id) return { error: "id is required" };
  const node = getGlobals().nodeName;
  if (!node) return { error: "--node is required" };
  if (!args.rel) return { error: "--rel is required" };
  if (!args.every) return { error: "--every is required" };
  const intervalSeconds = parseDurationSeconds(args.every);
  if (intervalSeconds === null) return { error: `invalid --every: ${args.every}` };
  const mode = args.mode ?? "auto";
  if (mode !== "auto" && mode !== "text" && mode !== "vision") {
    return { error: "--mode must be one of auto, text, vision" };
  }
  return { input: { id, node, rel: args.rel, mode, intervalSeconds } };
}

function describeCallerError(err: unknown): string {
  const issues = (err as { cause?: { issues?: unknown[] } } | undefined)?.cause?.issues;
  if (Array.isArray(issues)) {
    const messages = issues
      .map((issue) => (issue as { message?: unknown }).message)
      .filter((message): message is string => typeof message === "string");
    if (messages.length > 0) return messages.join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

async function runAdd(argv: string[]): Promise<number> {
  const parsed = parseAddArgs(argv);
  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stderr.write(`bench schedule add: ${parsed.message}\n`);
    return 1;
  }
  const planned = planAddArgs(parsed.args);
  if ("error" in planned) {
    process.stderr.write(`bench schedule add: ${planned.error}\n`);
    return 1;
  }
  try {
    await (await resolveCaller()).benchScheduleAdd(planned.input);
  } catch (err) {
    process.stderr.write(`bench schedule add: ${describeCallerError(err)}\n`);
    return 1;
  }
  process.stdout.write(`added ${planned.input.id}\n`);
  return 0;
}

function refuseUnknownId(prefix: string, id: string): number {
  process.stderr.write(`${prefix}: no bench schedule with id '${id}'\n`);
  return 1;
}

async function runToggle(args: string[]): Promise<number> {
  const [id, state] = args;
  if (state !== "on" && state !== "off") {
    process.stderr.write("bench schedule toggle: state must be on|off\n");
    return 1;
  }
  if (!id) {
    process.stderr.write("bench schedule toggle: id is required\n");
    return 1;
  }
  const c = await resolveCaller();
  const schedules = await c.benchScheduleList();
  if (!schedules.some((row) => row.id === id)) return refuseUnknownId("bench schedule toggle", id);
  await c.benchScheduleToggle({ id, enabled: state === "on" });
  process.stdout.write(`${id} ${state === "on" ? "enabled" : "disabled"}\n`);
  return 0;
}

async function runRm(args: string[]): Promise<number> {
  const id = args[0];
  if (!id) {
    process.stderr.write("bench schedule rm: id is required\n");
    return 1;
  }
  const c = await resolveCaller();
  const schedules = await c.benchScheduleList();
  if (!schedules.some((row) => row.id === id)) return refuseUnknownId("bench schedule rm", id);
  await c.benchScheduleRemove({ id });
  process.stdout.write(`removed ${id}\n`);
  return 0;
}

async function runStatus(argv: string[]): Promise<number> {
  const parsed = parseJsonArgs(argv);
  if ("bail" in parsed) return parsed.bail;
  const c = await resolveCaller();
  const [schedules, loop] = await Promise.all([c.benchScheduleList(), c.benchSchedulerStatus()]);
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({ loop, schedules }, null, 2)}\n`);
    return 0;
  }
  for (const line of formatScheduleRows(schedules)) process.stdout.write(`${line}\n`);
  process.stdout.write(`${formatLoopLine(loop)}\n`);
  for (const entry of loop.recent) process.stdout.write(`${formatRecentEntry(entry)}\n`);
  return 0;
}

function newRecentEntries(before: LoopStatus, after: LoopStatus): RecentEntry[] {
  if (after.recent.length > before.recent.length) {
    return after.recent.slice(before.recent.length);
  }
  const seen = new Set(before.recent.map((entry) => `${entry.ts}\u0000${entry.id}`));
  return after.recent.filter((entry) => !seen.has(`${entry.ts}\u0000${entry.id}`));
}

async function runKick(): Promise<number> {
  const c = await resolveCaller();
  const before = await c.benchSchedulerStatus();
  try {
    await c.benchSchedulerKick();
  } catch (err) {
    process.stderr.write(`bench schedule kick: ${describeCallerError(err)}\n`);
    return 1;
  }
  const after = await c.benchSchedulerStatus();
  const fresh = newRecentEntries(before, after);
  if (fresh.length === 0) {
    process.stdout.write("no schedules due\n");
    return 0;
  }
  let failed = false;
  for (const entry of fresh) {
    process.stdout.write(`${formatRecentEntry(entry)}\n`);
    if (!entry.ok) failed = true;
  }
  return failed ? 1 : 0;
}

type RunArgs = { tickIntervalSeconds: number } | { bail: number };

function intervalError(): { bail: number } {
  process.stderr.write("--interval must be an integer between 30 and 3600\n");
  return { bail: 1 };
}

function parseIntervalSeconds(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const value = Number.parseInt(raw, 10);
  return value >= 30 && value <= 3600 ? value : null;
}

function parseRunArgs(argv: string[]): RunArgs {
  let tickIntervalSeconds = 60;
  const rest = [...argv];
  let arg = rest.shift();
  while (arg !== undefined) {
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(USAGE);
      return { bail: 0 };
    }
    if (flagName(arg) !== "--interval") {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return { bail: 1 };
    }
    const value = parseIntervalSeconds(flagInlineValue(arg, rest));
    if (value === null) return intervalError();
    tickIntervalSeconds = value;
    arg = rest.shift();
  }
  return { tickIntervalSeconds };
}

async function drainInflight(c: BenchScheduleCaller): Promise<void> {
  let warned = false;
  for (;;) {
    const status = await c.benchSchedulerStatus();
    if (!status.inflight) return;
    if (!warned) {
      process.stderr.write(
        "bench-scheduler: stop requested, waiting for in-flight bench to finish\n",
      );
      warned = true;
    }
    await sleep(1000);
  }
}

async function runLoop(argv: string[]): Promise<number> {
  const parsed = parseRunArgs(argv);
  if ("bail" in parsed) return parsed.bail;
  const c = await resolveCaller();
  try {
    await c.benchSchedulerStart({ tickIntervalSeconds: parsed.tickIntervalSeconds });
  } catch (err) {
    process.stderr.write(`bench schedule run: ${describeCallerError(err)}\n`);
    return 1;
  }
  const shutdown = waitForShutdown();
  process.stderr.write(
    `bench-scheduler: running (tick every ${String(parsed.tickIntervalSeconds)}s); Ctrl-C to stop\n`,
  );
  try {
    await shutdown;
  } finally {
    await c.benchSchedulerStop();
    await drainInflight(c);
  }
  process.stderr.write("bench-scheduler: stopped\n");
  return 0;
}

export async function runBenchSchedule(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === undefined || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!isKnownSub(sub)) {
    process.stderr.write(`Unknown bench schedule subcommand: ${sub}\n\n${USAGE}`);
    return 1;
  }
  const refusal = refuseUnsupportedGlobals(sub);
  if (refusal !== null) {
    process.stderr.write(refusal);
    return 1;
  }
  switch (sub) {
    case "add":
      return await runAdd(rest);
    case "kick":
      return await runKick();
    case "list":
      return await runList(rest);
    case "rm":
      return await runRm(rest);
    case "run":
      return await runLoop(rest);
    case "start":
    case "stop":
      process.stderr.write(`${LOOP_CONTROL_REFUSAL}\n`);
      return 1;
    case "status":
      return await runStatus(rest);
    case "toggle":
      return await runToggle(rest);
  }
}
