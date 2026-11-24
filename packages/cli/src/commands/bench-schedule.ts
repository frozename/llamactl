import type { router } from "@llamactl/remote";

import { llamactlHome } from "@llamactl/core/config/env";
import {
  EVAL_ENGINES,
  type EvalEngine,
  type PerfEngineClient,
  type PerfEngineClock,
  type PerfSuiteOptions,
} from "@llamactl/eval";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { getGlobals } from "../dispatcher.js";
import { mkdirSync } from "../safe-fs.js";

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

export interface PerfSuiteRunnerDeps {
  runPerfSuite(db: Database, opts: PerfSuiteOptions): Promise<unknown>;
  resolveEndpoint(node: string): { baseUrl: string; fetchImpl?: typeof fetch };
  openDb(): Database;
  clock?: PerfEngineClock;
}

export interface BenchScheduleTestSeams {
  caller?: BenchScheduleCaller;
  perfSuite?: Partial<PerfSuiteRunnerDeps>;
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
      [--kind suite --suite <perf-quick|perf-full> [--engine <llamacpp|omlx|gufo|kapitsa>] [--slots <n>] [--quant <label>] [--ctx <n>] [--flags=<args>]]
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
            --kind suite --suite <perf-quick|perf-full> registers a
            named perf suite instead of a bench preset; it needs an
            HTTP agent node already serving <rel>, and perf rows go to
            $DEV_STORAGE/eval/perf.sqlite (or ~/.llamactl/eval/perf.sqlite).
            --engine records the eval engine in perf provenance
            (llamacpp, omlx, gufo or kapitsa; default llamacpp).
            --slots declares the engine's slot count so c2_tps/c4_tps
            are measured through the agent gateway, which cannot reach
            /props; it must be a positive integer, and without it c2/c4
            record unavailable.
            --quant and --ctx record the quant label and context size
            in perf provenance (the gateway cannot report them);
            without them both fields record unavailable.
            --flags=<args> records the engine launch flags in perf
            provenance (the gateway cannot report them); the value is
            split on whitespace, and without it flags record unavailable.
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

interface SuiteRunRequest {
  scheduleId: string;
  suite: string;
  node: string;
  rel: string;
  engine?: string;
  slots?: number;
  quant?: string;
  ctx?: number;
  flags?: string[];
}

type PerfBenchSuiteRunner = (req: SuiteRunRequest) => Promise<void>;
type ResolvedEndpoint = { baseUrl: string; fetchImpl?: typeof fetch };

export function defaultPerfDbPath(): string {
  const dir = join(llamactlHome(), "eval");
  mkdirSync(dir, { recursive: true });
  return join(dir, "perf.sqlite");
}

function defaultOpenDb(): Database {
  return new Database(defaultPerfDbPath());
}

export function servedModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return [];
  }
  const data = (payload as Record<string, unknown>)["data"];
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Record<string, unknown>)["id"];
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

async function assertServesModel(client: PerfEngineClient, req: SuiteRunRequest): Promise<void> {
  const ids = servedModelIds(await client.listModels());
  if (ids.includes(req.rel)) return;
  throw new Error(
    `node '${req.node}' is not serving '${req.rel}' (serving: ${ids.join(", ") || "nothing"})`,
  );
}

async function defaultEndpoint(node: string): Promise<ResolvedEndpoint> {
  const { config: cfgMod, configSchema, makePinnedFetch } = await import("@llamactl/remote");
  const r = cfgMod.resolveNode(cfgMod.loadConfig(), node);
  if (r.node.endpoint.startsWith("inproc://")) {
    throw new Error(`perf suite runs need an HTTP agent endpoint; node '${node}' is in-process`);
  }
  const kind = configSchema.resolveNodeKind(r.node);
  if (r.node.endpoint === "" || kind !== "agent") {
    throw new Error(
      `perf suite runs need an HTTP agent endpoint; node '${node}' is a ${kind} node`,
    );
  }
  const token = cfgMod.resolveToken(r.user);
  const pinned = makePinnedFetch(r.node);
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${token}`);
    return await pinned(input, { ...init, headers });
  };
  return { baseUrl: r.node.endpoint, fetchImpl: fetchImpl as typeof fetch };
}

async function suiteEndpoint(
  node: string,
  override: PerfSuiteRunnerDeps["resolveEndpoint"] | undefined,
): Promise<ResolvedEndpoint> {
  if (override !== undefined) return override(node);
  return await defaultEndpoint(node);
}

export function createPerfBenchSuiteRunner(
  overrides: Partial<PerfSuiteRunnerDeps> = {},
): PerfBenchSuiteRunner {
  return async (req) => {
    const ev = await import("@llamactl/eval");
    // #521: schedules saved before engine existed carry none; they keep
    // the pre-#521 llamacpp default. An id outside EVAL_ENGINES is the
    // runner's to reject, before any endpoint work, into lastError.
    const engine = req.engine ?? "llamacpp";
    if (!(EVAL_ENGINES as readonly string[]).includes(engine)) {
      throw new Error(
        `unknown engine '${engine}' for schedule '${req.scheduleId}' (expected one of ${EVAL_ENGINES.join(", ")})`,
      );
    }
    if (req.slots !== undefined && (!Number.isSafeInteger(req.slots) || req.slots <= 0)) {
      throw new Error(
        `invalid slots ${String(req.slots)} for schedule '${req.scheduleId}' (expected a positive integer)`,
      );
    }
    if (req.ctx !== undefined && (!Number.isSafeInteger(req.ctx) || req.ctx <= 0)) {
      throw new Error(
        `invalid ctx ${String(req.ctx)} for schedule '${req.scheduleId}' (expected a positive integer)`,
      );
    }
    if (req.quant !== undefined && !QUANT_LABEL_RE.test(req.quant)) {
      throw new Error(
        `invalid quant '${req.quant}' for schedule '${req.scheduleId}' (expected a non-blank quant label)`,
      );
    }
    assertDeclaredLaunchFlags(req);
    const preset = ev.resolvePerfSuite(req.suite);
    const ep = await suiteEndpoint(req.node, overrides.resolveEndpoint);
    const clock: PerfEngineClock = overrides.clock ?? { now: () => performance.now() };
    // Through the agent gateway only /v1/* is forwarded and /tokenize is
    // not routed, so every prefill_*_tps records 'unavailable' with this
    // reason. Direct llama-server resolution is a follow-up.
    const prefillReason = `prefill for ${req.rel} on node '${req.node}' is not measured; scheduled suites reach the engine through the agent gateway, which forwards only /v1/* and not the engine's /tokenize`;
    const client = ev.createHttpPerfEngineClient(ep.baseUrl, {
      clock,
      model: req.rel,
      ...(ep.fetchImpl ? { fetchImpl: ep.fetchImpl } : {}),
    });
    await assertServesModel(client, req);
    // Scheduled runs only reach the engine through the agent gateway, so the
    // binary, GGUF, quant, ctx, launch flags and HF revision are genuinely
    // unknown; each lands as null with its own unavailable reason instead of a
    // guess. A schedule that declares quant, ctx or launch flags overrides the
    // null with the declared value, and the gateway reason then goes unused.
    const provenance = await ev.collectEvalProvenance(
      {
        engine: engine as EvalEngine,
        quant: null,
        ctx: null,
        flags: req.flags ?? null,
        reasons: {
          binary_path: `scheduled suites reach ${req.rel} through the agent gateway; the engine binary path is not known`,
          gguf_path: `scheduled suites reach ${req.rel} through the agent gateway; the GGUF path is not known`,
          quant: `scheduled suites reach ${req.rel} through the agent gateway; the quant label is not known`,
          ctx: `scheduled suites reach ${req.rel} through the agent gateway; the context size is not known`,
          flags: `scheduled suites reach ${req.rel} through the agent gateway; the engine launch flags are not known`,
          hf_revision: `scheduled suites reach ${req.rel} through the agent gateway; no GGUF path to derive an HF revision from`,
        },
        ...(req.quant !== undefined ? { quant: req.quant } : {}),
        ...(req.ctx !== undefined ? { ctx: req.ctx } : {}),
      },
      ev.defaultProvenanceReaders(),
    );
    // The CLI bench-schedule runner cannot build per-engine host readers
    // because the engine process lives on a remote node behind the agent
    // gateway — the CLI host's own /proc and GTT counters are not the
    // remote engine's, so `readers` stays unset. Instead pass perf-suite
    // readerReasons that name the node and model so every unavailable
    // metric explains why.
    const readerReasons = {
      io: `disk I/O for ${req.rel} lives on node '${req.node}'; scheduled suites reach it through the agent gateway, which exposes no engine process counters`,
      peakRss: `peak RSS (VmHWM) for ${req.rel} lives on node '${req.node}'; scheduled suites reach it through the agent gateway, which exposes no engine process counters`,
      gtt: `GTT usage for ${req.rel} lives on node '${req.node}'; scheduled suites reach it through the agent gateway, which exposes no engine process counters`,
    };
    // The gateway forwards only /v1/*, so the engine's GET /props slot count
    // is unreachable; c2/c4 record this reason instead of a probe result.
    const slotsReason = `slot count for ${req.rel} on node '${req.node}' is unknown; scheduled suites reach the engine through the agent gateway, which forwards only /v1/* and not the engine's /props`;
    const loadReason = `model load for ${req.rel} happens on node '${req.node}'; scheduled suites reach an already-serving engine through the agent gateway and do not load or reload it, so cold/warm load time is not measured`;
    const db = (overrides.openDb ?? defaultOpenDb)();
    try {
      await (overrides.runPerfSuite ?? ev.runPerfSuite)(db, {
        ...preset,
        run_id: `${req.scheduleId}-${new Date().toISOString()}`,
        model_name: req.rel,
        client,
        clock,
        provenance,
        readerReasons,
        ...(req.slots !== undefined ? { slots: req.slots } : { slotsReason }),
        loadReason,
        prefillReason,
        ...(req.ctx !== undefined ? { ctx: req.ctx } : {}),
      });
    } finally {
      db.close();
    }
  };
}

function resolveCaller(): Promise<BenchScheduleCaller> {
  if (seams.caller) return Promise.resolve(seams.caller);
  return import("@llamactl/remote").then(({ router: remoteRouter }) =>
    remoteRouter.createCaller({
      benchSuiteRunner: createPerfBenchSuiteRunner(seams.perfSuite),
    }),
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
  kind: string | undefined;
  suite: string | undefined;
  engine: string | undefined;
  slots: string | undefined;
  quant: string | undefined;
  ctx: string | undefined;
  flags: string | undefined;
}

type AddParse =
  | { kind: "ok"; args: AddArgs }
  | { kind: "help" }
  | { kind: "error"; message: string };

const VALUED_ADD_FLAGS: ReadonlySet<string> = new Set([
  "--every",
  "--mode",
  "--rel",
  "--kind",
  "--suite",
  "--engine",
  "--slots",
  "--quant",
  "--ctx",
  "--flags",
]);

function flagName(arg: string): string {
  const eq = arg.indexOf("=");
  return eq >= 0 ? arg.slice(0, eq) : arg;
}

function flagInlineValue(arg: string, queue: string[]): string | undefined {
  const eq = arg.indexOf("=");
  return eq >= 0 ? arg.slice(eq + 1) : queue.shift();
}

// A space-separated `--flags` value that begins with a dash would swallow the
// first launch flag as the flag value and drop the rest, so require `=` there.
const FLAGS_ATTACH_REQUIRED = `--flags must be attached with '=' when its value starts with '-'; use --flags="..."`;

function assignAddFlag(args: AddArgs, name: string, value: string): void {
  if (name === "--rel") args.rel = value;
  else if (name === "--mode") args.mode = value;
  else if (name === "--kind") args.kind = value;
  else if (name === "--suite") args.suite = value;
  else if (name === "--engine") args.engine = value;
  else if (name === "--slots") args.slots = value;
  else if (name === "--quant") args.quant = value;
  else if (name === "--ctx") args.ctx = value;
  else if (name === "--flags") args.flags = value;
  else args.every = value;
}

function parseAddArgs(argv: string[]): AddParse {
  const args: AddArgs = {
    positional: [],
    rel: undefined,
    mode: undefined,
    every: undefined,
    kind: undefined,
    suite: undefined,
    engine: undefined,
    slots: undefined,
    quant: undefined,
    ctx: undefined,
    flags: undefined,
  };
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
    if (name === "--flags" && !arg.includes("=") && (rest[0]?.startsWith("-") ?? false)) {
      return { kind: "error", message: FLAGS_ATTACH_REQUIRED };
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
        kind?: "preset" | "suite";
        suite?: string;
        engine?: string;
        slots?: number;
        quant?: string;
        ctx?: number;
        flags?: string[];
      };
    }
  | { error: string };

function validateSuiteArgs(
  kind: "preset" | "suite" | undefined,
  suite: string | undefined,
  engine: string | undefined,
): string | null {
  if (kind === "suite" && !suite) {
    return "--suite is required when kind is 'suite'";
  }
  if (kind !== "suite" && suite) {
    return "--suite is only valid when kind is 'suite'";
  }
  if (engine !== undefined && kind !== "suite") {
    return "--engine is only valid when kind is 'suite'";
  }
  if (engine !== undefined && !(EVAL_ENGINES as readonly string[]).includes(engine)) {
    return `unknown engine '${engine}' (expected one of ${EVAL_ENGINES.join(", ")})`;
  }
  return null;
}

function validateSlotsArg(
  kind: "preset" | "suite" | undefined,
  slots: string | undefined,
): { slots?: number; error?: string } {
  if (slots === undefined) return {};
  if (kind !== "suite") {
    return { error: "--slots is only valid when kind is 'suite'" };
  }
  if (!/^\d+$/.test(slots)) return { error: "--slots must be a positive integer" };
  const n = Number(slots);
  if (!Number.isSafeInteger(n) || n <= 0) {
    return { error: "--slots must be a positive integer" };
  }
  return { slots: n };
}

const QUANT_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const LAUNCH_FLAG_TOKEN_RE = /^\S+$/;

function assertDeclaredLaunchFlags(req: { scheduleId: string; flags?: unknown }): void {
  const flags = req.flags;
  if (flags === undefined) return;
  if (
    !Array.isArray(flags) ||
    flags.length === 0 ||
    flags.some((t: unknown) => typeof t !== "string" || !LAUNCH_FLAG_TOKEN_RE.test(t))
  ) {
    throw new Error(
      `invalid flags for schedule '${req.scheduleId}' (expected a non-empty list of launch-flag tokens)`,
    );
  }
}

function validateProvenanceArgs(
  kind: "preset" | "suite" | undefined,
  quant: string | undefined,
  ctx: string | undefined,
): { quant?: string; ctx?: number; error?: string } {
  if (quant !== undefined && kind !== "suite") {
    return { error: "--quant is only valid when kind is 'suite'" };
  }
  if (ctx !== undefined && kind !== "suite") {
    return { error: "--ctx is only valid when kind is 'suite'" };
  }
  if (quant !== undefined && !QUANT_LABEL_RE.test(quant)) {
    return { error: "--quant must be a non-blank quant label" };
  }
  if (ctx === undefined) {
    return quant !== undefined ? { quant } : {};
  }
  const n = Number(ctx);
  if (!/^\d+$/.test(ctx) || !Number.isSafeInteger(n) || n <= 0) {
    return { error: "--ctx must be a positive integer" };
  }
  return {
    ...(quant !== undefined ? { quant } : {}),
    ctx: n,
  };
}

function validateFlagsArg(
  kind: "preset" | "suite" | undefined,
  flags: string | undefined,
): { flags?: string[]; error?: string } {
  if (flags === undefined) return {};
  if (kind !== "suite") {
    return { error: "--flags is only valid when kind is 'suite'" };
  }
  const tokens = flags.split(/\s+/).filter((t) => t !== "");
  if (tokens.length === 0) {
    return { error: "--flags must list at least one launch flag" };
  }
  return { flags: tokens };
}

function optionalAddFields(
  kind: "preset" | "suite" | undefined,
  suite: string | undefined,
  engine: string | undefined,
  slots: number | undefined,
  quant: string | undefined,
  ctx: number | undefined,
  flags: string[] | undefined,
): {
  kind?: "preset" | "suite";
  suite?: string;
  engine?: string;
  slots?: number;
  quant?: string;
  ctx?: number;
  flags?: string[];
} {
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(suite !== undefined ? { suite } : {}),
    ...(engine !== undefined ? { engine } : {}),
    ...(slots !== undefined ? { slots } : {}),
    ...(quant !== undefined ? { quant } : {}),
    ...(ctx !== undefined ? { ctx } : {}),
    ...(flags !== undefined ? { flags } : {}),
  };
}

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
  const kind = args.kind ? (args.kind as "preset" | "suite") : undefined;
  const kindError = validateSuiteArgs(kind, args.suite, args.engine);
  if (kindError) return { error: kindError };
  const slotsResult = validateSlotsArg(kind, args.slots);
  if (slotsResult.error) return { error: slotsResult.error };
  const provenance = validateProvenanceArgs(kind, args.quant, args.ctx);
  if (provenance.error) return { error: provenance.error };
  const flagsResult = validateFlagsArg(kind, args.flags);
  if (flagsResult.error) return { error: flagsResult.error };
  const input: {
    id: string;
    node: string;
    rel: string;
    mode: "auto" | "text" | "vision";
    intervalSeconds: number;
    kind?: "preset" | "suite";
    suite?: string;
    engine?: string;
    slots?: number;
    quant?: string;
    ctx?: number;
    flags?: string[];
  } = {
    id,
    node,
    rel: args.rel,
    mode,
    intervalSeconds,
    ...optionalAddFields(
      kind,
      args.suite,
      args.engine,
      slotsResult.slots,
      provenance.quant,
      provenance.ctx,
      flagsResult.flags,
    ),
  };
  return { input };
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
