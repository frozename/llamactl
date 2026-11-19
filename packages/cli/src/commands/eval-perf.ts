import type { GttObservation } from "@llamactl/core/resources/memory";
import type {
  EvalEngine,
  EvalProvenance,
  PerfEngineClock,
  PerfRunRow,
  PerfSuiteOptions,
  PerfSuitePreset,
  PerfSuiteReaderReasons,
  PerfSuiteReaders,
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

import { defaultPerfDbPath, servedModelIds } from "./bench-schedule.js";

/**
 * `llamactl eval perf` runs the perf suite against an engine already serving
 * at --url. On a loopback URL it wires the engine PID's /proc I/O and VmHWM
 * readers (Linux) plus a GTT probe into runPerfSuite, fills provenance from
 * --binary/--gguf/--quant/--ctx/--flags/--slots, refuses --pid off loopback,
 * and records per-reader unavailable reasons everywhere else. The c2/c4 slot
 * count comes from --slots, else (for llamacpp) from `GET /props` total_slots;
 * when neither yields a count the run records an engine-named slotsReason.
 * `__setEvalPerfTestSeams` narrows every side effect so the command stays
 * hermetic under test.
 */

export interface EvalPerfTestSeams {
  runPerfSuite?: (db: Database, opts: PerfSuiteOptions) => Promise<unknown>;
  fetchImpl?: typeof fetch;
  provenanceReaders?: ProvenanceReaders;
  platform?: NodeJS.Platform;
  readFile?: (path: string) => Promise<string>;
  probeGtt?: () => Promise<GttObservation>;
  clock?: { now(): number };
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

type PerfParse = { values: Record<string, string> } | { error: string };

function parsePerfArgv(argv: string[]): PerfParse {
  const values: Record<string, string> = {};
  const rest = [...argv];
  let arg = rest.shift();
  while (arg !== undefined) {
    if (!arg.startsWith("--")) return { error: `unexpected argument '${arg}'` };
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(0, eq) : arg;
    if (!VALUED_FLAGS.has(name)) return { error: `unknown flag '${arg}'` };
    const value = eq >= 0 ? arg.slice(eq + 1) : rest.shift();
    if (value === undefined) return { error: `missing value for ${name}` };
    values[name] = value;
    arg = rest.shift();
  }
  return { values };
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

function readPositiveInts(values: Record<string, string>): ReadInts {
  const pid = parsePositiveInt(values["--pid"], "--pid");
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

function splitFlags(raw: string | undefined): string[] {
  if (raw === undefined) return [];
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
  flags: string[];
}

type ResolveResult = RunInput | { error: string };

function resolveSuite(id: string): { preset: PerfSuitePreset } | { error: string } {
  try {
    return { preset: resolvePerfSuite(id) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function resolveRunInput(values: Record<string, string>): ResolveResult {
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
  const ints = readPositiveInts(values);
  if (ints.error !== null) return { error: ints.error };
  if (ints.pid !== null && !location.loopback) {
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
  pid: number | null,
): { readers: PerfSuiteReaders | undefined; reasons: PerfSuiteReaderReasons } {
  if (!loopback) return { readers: undefined, reasons: remoteReasons(url) };

  const platform = seams.platform ?? process.platform;
  const host = createPerfHostReaders({
    pid,
    ...(seams.platform !== undefined ? { platform: seams.platform } : {}),
    ...(seams.readFile !== undefined ? { readFile: seams.readFile } : {}),
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

function buildOpts(args: {
  input: RunInput;
  runId: string;
  client: PerfEngineClientLike;
  clock: PerfEngineClock;
  provenance: PerfSuiteOptions["provenance"];
  readers: PerfSuiteReaders | undefined;
  readerReasons: PerfSuiteReaderReasons;
  slots: number | null;
  slotsReason: string | undefined;
}): PerfSuiteOptions {
  const { input, runId, client, clock, provenance, readers, readerReasons, slots, slotsReason } =
    args;
  return {
    ...input.preset,
    run_id: runId,
    model_name: input.model,
    client,
    clock,
    provenance,
    readerReasons,
    ...(readers !== undefined ? { readers } : {}),
    ...(input.ctx !== null ? { ctx: input.ctx } : {}),
    ...(slots !== null ? { slots } : {}),
    ...(slotsReason !== undefined ? { slotsReason } : {}),
  };
}

type SlotResolution = { slots: number | null; slotsReason: string | undefined };

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

export async function runEvalPerf(argv: string[]): Promise<number> {
  const parsed = parsePerfArgv(argv);
  if ("error" in parsed) return fail(parsed.error);
  const values = parsed.values;

  const resolved = resolveRunInput(values);
  if ("error" in resolved) return fail(resolved.error);

  const clock: PerfEngineClock = seams.clock ?? { now: () => performance.now() };
  const client = createHttpPerfEngineClient(resolved.url, {
    clock,
    model: resolved.model,
    ...(seams.fetchImpl !== undefined ? { fetchImpl: seams.fetchImpl } : {}),
  });

  const served = servedModelIds(await client.listModels());
  if (!served.includes(resolved.model)) {
    return fail(
      `engine at ${resolved.url} is not serving '${resolved.model}' (serving: ${served.join(", ") || "nothing"})`,
    );
  }

  const provenance = await buildProvenance(values, resolved);
  const { slots, slotsReason } = await resolveSlots(resolved);
  const { readers, reasons: readerReasons } = hostReaders(
    resolved.url,
    resolved.loopback,
    resolved.pid,
  );

  const runId = values["--run-id"] ?? `perf-${resolved.model}-${new Date().toISOString()}`;
  const db = new Database(values["--db"] ?? defaultPerfDbPath());
  try {
    const runner = seams.runPerfSuite ?? runPerfSuite;
    await runner(
      db,
      buildOpts({
        input: resolved,
        runId,
        client,
        clock,
        provenance,
        readers,
        readerReasons,
        slots,
        slotsReason,
      }),
    );
    process.stdout.write(`run_id: ${runId}\n`);
    printPerfTable(listPerfRuns(db, { run_id: runId }));
  } finally {
    db.close();
  }
  return 0;
}
