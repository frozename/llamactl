import type { GttObservation } from "@llamactl/core/resources/memory";
import type {
  EvalEngine,
  EvalProvenance,
  ModelSpec,
  PerfEngineClock,
  PerfRunRow,
  PerfSuiteLoadHooks,
  PerfSuiteOptions,
  PerfSuitePreset,
  PerfSuiteReaderReasons,
  PerfSuiteReaders,
  ProcPidRusage,
  ProvenanceReaders,
} from "@llamactl/eval";

import {
  collectEvalProvenance,
  createHttpPerfEngineClient,
  createPerfHostReaders,
  defaultProvenanceReaders,
  EVAL_ENGINES,
  listPerfRuns,
  probeEngineSlots,
  resolvePerfSuite,
  runPerfSuite,
} from "@llamactl/eval";
import { Database } from "bun:sqlite";

import type { EvalPerfLaunchDeps } from "./eval-perf-launch.js";

import { defaultPerfDbPath, servedModelIds } from "./bench-schedule.js";
import {
  createLaunchLoadHooks,
  defaultLaunchDeps,
  LAUNCH_IO_REASON,
  LAUNCH_SLOTS_REASON,
  launchRefusal,
  preflightLaunch,
  validateLaunch,
} from "./eval-perf-launch.js";

/**
 * `llamactl eval perf` runs the perf suite against an engine serving at
 * --url. Without --launch it requires the engine to be serving already; with
 * --launch it boots llama-server through the eval matrix lifecycle inside the
 * suite's load hooks, measures cold/warm load, and tears the owned boot down.
 * `__setEvalPerfTestSeams` narrows every side effect so the command stays
 * hermetic under test.
 */

export interface EvalPerfTestSeams {
  runPerfSuite?: (db: Database, opts: PerfSuiteOptions) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  provenanceReaders?: ProvenanceReaders;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  procPidRusage?: ProcPidRusage;
  probeGtt?: () => Promise<GttObservation>;
  clock?: { now(): number };
  launch?: EvalPerfLaunchDeps;
}

let seams: EvalPerfTestSeams = {};

export function __setEvalPerfTestSeams(next: EvalPerfTestSeams): void {
  seams = { ...next };
}

export function __resetEvalPerfTestSeams(): void {
  seams = {};
}

const VALUED_FLAGS: ReadonlySet<string> = new Set([
  "--binary",
  "--ctx",
  "--db",
  "--engine",
  "--flags",
  "--gguf",
  "--hf-revision",
  "--model",
  "--pid",
  "--quant",
  "--run-id",
  "--slots",
  "--suite",
  "--url",
]);

const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--launch"]);

type PerfParse = { values: Record<string, string>; launch: boolean } | { error: string };

function parsePerfArgv(argv: string[]): PerfParse {
  const values: Record<string, string> = {};
  const rest = [...argv];
  let arg = rest.shift();
  let launch = false;
  while (arg !== undefined) {
    const result = parseSingleArg(arg, rest, values);
    if (result.error !== null) return { error: result.error, launch: false };
    launch = launch || result.launch;
    arg = rest.shift();
  }
  return { values, launch };
}

function parseSingleArg(
  arg: string,
  rest: string[],
  values: Record<string, string>,
): { error: string | null; launch: boolean } {
  if (!arg.startsWith("--")) return { error: `unexpected argument '${arg}'`, launch: false };
  const eq = arg.indexOf("=");
  const name = eq >= 0 ? arg.slice(0, eq) : arg;
  if (BOOLEAN_FLAGS.has(name)) {
    if (eq >= 0) return { error: `--launch takes no value`, launch: false };
    return { error: null, launch: true };
  }
  if (!VALUED_FLAGS.has(name)) return { error: `unknown flag '${arg}'`, launch: false };
  const value = eq >= 0 ? arg.slice(eq + 1) : rest.shift();
  if (value === undefined) return { error: `missing value for ${name}`, launch: false };
  values[name] = value;
  return { error: null, launch: false };
}

function fail(message: string): number {
  process.stderr.write(`eval perf: ${message}\n`);
  return 1;
}

type PositiveInt = { value: number | null; error: string | null };

function parsePositiveInt(raw: string | undefined, flag: string): PositiveInt {
  if (raw === undefined) return { value: null, error: null };
  if (!/^\d+$/.test(raw)) return { value: null, error: `${flag} must be a positive integer` };
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { value: null, error: `${flag} must be a positive integer` };
  }
  return { value, error: null };
}

type ReadInts = {
  pid: number | null;
  ctx: number | null;
  slots: number | null;
  error: string | null;
};

function readPositiveInts(values: Record<string, string>, validatePid: boolean): ReadInts {
  const pid = validatePid
    ? parsePositiveInt(values["--pid"], "--pid")
    : { value: null, error: null };
  const ctx = parsePositiveInt(values["--ctx"], "--ctx");
  const slots = parsePositiveInt(values["--slots"], "--slots");
  const error = pid.error ?? ctx.error ?? slots.error;
  if (error !== null) return { pid: null, ctx: null, slots: null, error };
  return { pid: pid.value, ctx: ctx.value, slots: slots.value, error: null };
}

function loopbackFor(url: string): { hostname: string; loopback: boolean } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // WHATWG URL parsing normalizes IPv4 shorthand ('127.1' -> '127.0.0.1')
  // and brackets IPv6 ('[::1]'), so a literal dotted-quad match is the only
  // 127/8 form left; a prefix match would also accept DNS names such as
  // '127.evil.example'.
  const hostname = parsed.hostname;
  const loopback =
    hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
  return { hostname, loopback };
}

function splitFlags(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  return raw.split(/\s+/).filter((token) => token !== "");
}

interface RunInput {
  url: string;
  model: string;
  engine: EvalEngine;
  preset: PerfSuitePreset;
  pid: number | null;
  ctx: number | null;
  slots: number | null;
  loopback: boolean;
  hostname: string;
  flags: readonly string[] | null;
}

type ResolveResult = RunInput | { error: string };

function resolveSuite(id: string): { preset: PerfSuitePreset } | { error: string } {
  try {
    return { preset: resolvePerfSuite(id) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveRunInput(values: Record<string, string>, launch = false): ResolveResult {
  const url = values["--url"];
  const model = values["--model"];
  if (url === undefined || url === "" || model === undefined || model === "") {
    return { error: "--url and --model are required" };
  }
  const engineRaw = values["--engine"] ?? "llamacpp";
  if (!(EVAL_ENGINES as readonly string[]).includes(engineRaw)) {
    return { error: `unknown engine '${engineRaw}' (expected one of ${EVAL_ENGINES.join(", ")})` };
  }
  const location = loopbackFor(url);
  if (location === null) return { error: `invalid --url '${url}'` };
  const ints = readPositiveInts(values, !launch);
  if (ints.error !== null) return { error: ints.error };
  if (ints.pid !== null && !location.loopback && !launch) {
    return {
      error: `--pid needs a loopback --url (got ${location.hostname}); host counters are read on this machine`,
    };
  }
  const suite = resolveSuite(values["--suite"] ?? "perf-quick");
  if ("error" in suite) return { error: suite.error };
  return {
    url,
    model,
    engine: engineRaw as EvalEngine,
    preset: suite.preset,
    pid: ints.pid,
    ctx: ints.ctx,
    slots: ints.slots,
    loopback: location.loopback,
    hostname: location.hostname,
    flags: splitFlags(values["--flags"]),
  };
}

function buildProvenance(values: Record<string, string>, input: RunInput): Promise<EvalProvenance> {
  return collectEvalProvenance(
    {
      engine: input.engine,
      binary_path: values["--binary"] ?? null,
      gguf_path: values["--gguf"] ?? null,
      quant: values["--quant"] ?? null,
      ctx: input.ctx,
      flags: input.flags,
      ...(values["--hf-revision"] !== undefined ? { hf_revision: values["--hf-revision"] } : {}),
      ...(input.flags === null
        ? {
            reasons: {
              flags: `no --flags given; the launch flags of the engine at ${input.url} are not known`,
            },
          }
        : {}),
    },
    seams.provenanceReaders ?? defaultProvenanceReaders(),
  );
}

function linuxGttReader(): () => Promise<GttObservation> {
  return (
    seams.probeGtt ??
    (async (): Promise<GttObservation> => {
      const { probeGpuGtt } = await import("@llamactl/fleet-supervisor");
      return await probeGpuGtt();
    })
  );
}

function hasAnyReader(readers: PerfSuiteReaders): boolean {
  return readers.io !== undefined || readers.peakRss !== undefined || readers.gtt !== undefined;
}

function remoteReasons(url: string): PerfSuiteReaderReasons {
  const perProcess = `engine at ${url} is not on this host; per-process counters need a local engine PID`;
  return {
    io: perProcess,
    peakRss: perProcess,
    gtt: `engine at ${url} is not on this host; GTT counters are read from the local /sys/class/drm`,
  };
}

function hostReaders(
  url: string,
  loopback: boolean,
  pid: number | null | (() => number | null),
): { readers: PerfSuiteReaders | undefined; reasons: PerfSuiteReaderReasons } {
  if (!loopback) return { readers: undefined, reasons: remoteReasons(url) };

  const platform = seams.platform ?? process.platform;
  const host = createPerfHostReaders({
    pid,
    ...(seams.platform !== undefined ? { platform: seams.platform } : {}),
    ...(seams.readFile !== undefined ? { readFile: seams.readFile } : {}),
    ...(seams.procPidRusage !== undefined ? { procPidRusage: seams.procPidRusage } : {}),
  });
  const reasons: PerfSuiteReaderReasons = { ...host.reasons };
  const readers: PerfSuiteReaders = { ...host.readers };
  if (platform === "linux") {
    readers.gtt = linuxGttReader();
  } else {
    reasons.gtt = `GTT counters (/sys/class/drm/card*/device/mem_info_gtt_used) are Linux-only; no GTT reader on ${platform}`;
  }
  return { readers: hasAnyReader(readers) ? readers : undefined, reasons };
}

function printPerfTable(rows: readonly PerfRunRow[]): void {
  process.stdout.write("| metric | status | value | reason |\n");
  for (const row of rows) {
    const value = row.metric.status === "ok" ? String(row.metric.value) : "unavailable";
    const reason = row.metric.status === "unavailable" ? row.metric.reason : "";
    process.stdout.write(`| ${row.metric_name} | ${row.metric.status} | ${value} | ${reason} |\n`);
  }
}

type PerfEngineClientLike = ReturnType<typeof createHttpPerfEngineClient>;

interface BuildOptsInput extends RunInput {
  runId: string;
  client: PerfEngineClientLike;
  clock: PerfEngineClock;
  provenance: PerfSuiteOptions["provenance"];
  readers: PerfSuiteReaders | undefined;
  readerReasons: PerfSuiteReaderReasons;
  slots: number | null;
  slotsReason: string | undefined;
  launchHooks: PerfSuiteLoadHooks | undefined;
}

function buildOpts(input: BuildOptsInput): PerfSuiteOptions {
  return {
    ...input.preset,
    run_id: input.runId,
    model_name: input.model,
    client: input.client,
    clock: input.clock,
    provenance: input.provenance,
    readerReasons: input.readerReasons,
    ...(input.launchHooks === undefined
      ? {
          loadReason: `eval perf runs against an engine already serving '${input.model}' at ${input.url}; it does not launch or reload the engine, so cold/warm model-load time is not measured`,
        }
      : { load: input.launchHooks }),
    ...(input.readers !== undefined ? { readers: input.readers } : {}),
    ...(input.ctx !== null ? { ctx: input.ctx } : {}),
    ...(input.slots !== null ? { slots: input.slots } : {}),
    ...(input.slotsReason !== undefined ? { slotsReason: input.slotsReason } : {}),
  };
}

type SlotResolution = { slots: number | null; slotsReason: string | undefined };

function withLaunchIoReason(
  readers: PerfSuiteReaders | undefined,
  reasons: PerfSuiteReaderReasons,
  launch: LaunchHooks | null,
): { readers: PerfSuiteReaders | undefined; reasons: PerfSuiteReaderReasons } {
  if (launch === null || readers?.io === undefined) {
    return { readers, reasons };
  }
  // Drop io for a --launch run: no single engine process spans the suite.
  const { io: _io, ...rest } = readers;
  const droppedReaders: PerfSuiteReaders = Object.keys(rest).length > 0 ? rest : {};
  reasons.io = LAUNCH_IO_REASON;
  return { readers: hasAnyReader(droppedReaders) ? droppedReaders : undefined, reasons };
}

async function resolveSlots(input: RunInput): Promise<SlotResolution> {
  if (input.slots !== null) return { slots: input.slots, slotsReason: undefined };
  if (input.engine !== "llamacpp") {
    return {
      slots: null,
      slotsReason: `engine '${input.engine}' does not advertise a llama-server GET /props slot count; pass --slots <n> to measure c2/c4`,
    };
  }
  const probe = await probeEngineSlots(input.url, {
    ...(seams.fetchImpl !== undefined ? { fetchImpl: seams.fetchImpl } : {}),
  });
  if (probe.slots !== null) return { slots: probe.slots, slotsReason: undefined };
  return {
    slots: null,
    slotsReason: `${probe.reason}; pass --slots <n> to measure c2/c4`,
  };
}

function resolveLaunchSlots(input: RunInput): SlotResolution {
  if (input.slots !== null) return { slots: input.slots, slotsReason: undefined };
  return { slots: null, slotsReason: LAUNCH_SLOTS_REASON };
}

interface LaunchHooks {
  hooks: PerfSuiteLoadHooks;
  pid(): number | null;
  foreign(): boolean;
  failure(): string | null;
  teardown(): Promise<void>;
}

type PreparedLaunch =
  | { ok: false; error: string }
  | { ok: true; spec: ModelSpec; launch: LaunchHooks };

async function prepareLaunch(
  values: Record<string, string>,
  input: RunInput,
): Promise<PreparedLaunch> {
  const validation = validateLaunch(values, {
    engine: input.engine,
    hostname: input.hostname,
    url: input.url,
    flags: input.flags,
    model: input.model,
  });
  if ("error" in validation) return { ok: false, error: validation.error };

  const refusal = launchRefusal(input.model, validation.spec.gguf_path);
  if (refusal !== null) return { ok: false, error: refusal };

  const preflightError = await preflightLaunch(input.url, seams.fetchImpl ?? fetch);
  if (preflightError !== null) return { ok: false, error: preflightError };

  const deps = seams.launch ?? defaultLaunchDeps();
  return {
    ok: true,
    spec: validation.spec,
    launch: createLaunchLoadHooks(validation.spec, deps),
  };
}

type LaunchContext = { spec: ModelSpec | null; launch: LaunchHooks | null };
type RequestedLaunch = LaunchContext | { error: string };

async function prepareRequestedLaunch(
  enabled: boolean,
  values: Record<string, string>,
  input: RunInput,
): Promise<RequestedLaunch> {
  if (!enabled) return { spec: null, launch: null };
  const prepared = await prepareLaunch(values, input);
  if (!prepared.ok) return { error: prepared.error };
  return { spec: prepared.spec, launch: prepared.launch };
}

function provenanceRunInput(input: RunInput, spec: ModelSpec | null): RunInput {
  if (spec === null) return input;
  return { ...input, flags: spec.extra_args ?? [] };
}

function pidForRun(
  input: RunInput,
  launch: LaunchHooks | null,
): number | null | (() => number | null) {
  return launch === null ? input.pid : (): number | null => launch.pid();
}

function launchExitStatus(launch: LaunchHooks | null, url: string, runId: string): number {
  if (launch === null) return 0;
  if (launch.foreign()) {
    return fail(
      `--launch did not start the engine at ${url}; run ${runId} measured an engine it did not launch`,
    );
  }
  const message = launch.failure();
  if (message !== null) {
    return fail(`--launch failed to start the engine at ${url}: ${message}`);
  }
  return 0;
}

export async function runEvalPerf(argv: string[]): Promise<number> {
  const parsed = parsePerfArgv(argv);
  if ("error" in parsed) return fail(parsed.error);
  const values = parsed.values;

  const resolved = resolveRunInput(values, parsed.launch);
  if ("error" in resolved) return fail(resolved.error);

  const clock: PerfEngineClock = seams.clock ?? { now: () => performance.now() };
  const client = createHttpPerfEngineClient(resolved.url, {
    clock,
    model: resolved.model,
    ...(seams.fetchImpl !== undefined ? { fetchImpl: seams.fetchImpl } : {}),
  });
  const runId = values["--run-id"] ?? `perf-${resolved.model}-${new Date().toISOString()}`;

  const launchContext = await prepareRequestedLaunch(parsed.launch, values, resolved);
  if ("error" in launchContext) return fail(launchContext.error);

  if (!parsed.launch) {
    const served = servedModelIds(await client.listModels());
    if (!served.includes(resolved.model)) {
      return fail(
        `engine at ${resolved.url} is not serving '${resolved.model}' (serving: ${served.join(", ") || "nothing"})`,
      );
    }
  }

  const provenance = await buildProvenance(
    values,
    provenanceRunInput(resolved, launchContext.spec),
  );
  const { slots, slotsReason } = parsed.launch
    ? resolveLaunchSlots(resolved)
    : await resolveSlots(resolved);
  const launchPid = pidForRun(resolved, launchContext.launch);
  const { readers: hostReadersResult, reasons: readerReasons } = hostReaders(
    resolved.url,
    resolved.loopback,
    launchPid,
  );
  const { readers, reasons: finalReaderReasons } = withLaunchIoReason(
    hostReadersResult,
    readerReasons,
    launchContext.launch,
  );

  const db = new Database(values["--db"] ?? defaultPerfDbPath());
  try {
    const runner = seams.runPerfSuite ?? runPerfSuite;
    await runner(
      db,
      buildOpts({
        ...resolved,
        runId,
        client,
        clock,
        provenance,
        readers,
        readerReasons: finalReaderReasons,
        slots,
        slotsReason,
        launchHooks: launchContext.launch?.hooks,
      }),
    );
    process.stdout.write(`run_id: ${runId}\n`);
    printPerfTable(listPerfRuns(db, { run_id: runId }));
    return launchExitStatus(launchContext.launch, resolved.url, runId);
  } finally {
    await launchContext.launch?.teardown();
    db.close();
  }
}
