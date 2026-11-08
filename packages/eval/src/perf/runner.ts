import type { GttObservation } from "@llamactl/core/resources/memory";
import type { Database } from "bun:sqlite";

import os from "node:os";

import type { EvalProvenance, MetricValue, PerfRunRow } from "../matrix/types.js";
import type { PerfEngineClient, PerfEngineClock, PerfStreamResult } from "./client.js";
import type { IoByteCounts } from "./normalise.js";

import { insertPerfRun } from "../matrix/store.js";
import { CONCURRENCY_LEVELS, PERF_SUITE_NAME } from "./metrics.js";
import {
  normaliseAcceptance,
  normaliseDecodeTps,
  normalisePrefillTps,
  okMetric,
  unavailableMetric,
} from "./normalise.js";

/** Load hooks bracket the engine's model-load window. Each hook MUST
 *  resolve only once the engine can actually serve requests — honour
 *  ModelHostReadiness (packages/core/src/engines/types.ts, issue #220):
 *  e.g. Gufo behind a llama-server shim lists its id on /v1/models
 *  before its weights finish loading. The runner performs no readiness
 *  probe of its own; it trusts the hooks. */
export interface PerfSuiteLoadHooks {
  cold?: () => void | Promise<void>;
  warm?: () => void | Promise<void>;
}

export interface PerfSuiteReaders {
  io?: () => IoByteCounts | null | Promise<IoByteCounts | null>;
  peakRss?: () => number | null | Promise<number | null>;
  gtt?: () => GttObservation | null | Promise<GttObservation | null>;
}

export interface PerfSuiteOptions {
  run_id: string;
  model_name: string;
  provenance: EvalProvenance;
  client: PerfEngineClient;
  clock: PerfEngineClock;
  slots?: number | null;
  ctx?: number | null;
  load?: PerfSuiteLoadHooks;
  readers?: PerfSuiteReaders;
  decodeTokens?: number;
  concurrencyPromptWords?: number;
  started_at?: string;
  host_machine?: string;
}

interface PerfSuiteRun {
  readonly opts: PerfSuiteOptions;
  readonly clock: PerfEngineClock;
  readonly client: PerfEngineClient;
  readonly decodeTokens: number;
  readonly concurrencyWords: number;
  readonly rows: PerfRunRow[];
  record(name: string, metric: MetricValue): void;
  step(names: readonly string[], fn: () => Promise<void>): Promise<void>;
  sampleIo(): Promise<IoByteCounts | null>;
}

const PREFILL_STEPS = [
  { tokens: 4096, metricName: "prefill_4k_tps" },
  { tokens: 16384, metricName: "prefill_16k_tps" },
  { tokens: 32768, metricName: "prefill_32k_tps" },
  { tokens: 65536, metricName: "prefill_64k_tps" },
] as const;

const DECODE_PROMPT = "Summarise the llamactl perf suite in one sentence.";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function validIoSample(sample: IoByteCounts | null): sample is IoByteCounts {
  return (
    sample !== null &&
    Number.isFinite(sample.readBytes) &&
    Number.isFinite(sample.writeBytes) &&
    sample.readBytes >= 0 &&
    sample.writeBytes >= 0
  );
}

function createPerfSuiteRun(db: Database, opts: PerfSuiteOptions): PerfSuiteRun {
  const recorded = new Set<string>();
  const rows: PerfRunRow[] = [];
  const startedAt = opts.started_at ?? new Date().toISOString();
  const hostMachine = opts.host_machine ?? os.hostname();

  const record = (name: string, metric: MetricValue): void => {
    if (recorded.has(name)) return;
    rows.push(
      insertPerfRun(db, {
        run_id: opts.run_id,
        model_name: opts.model_name,
        suite_name: PERF_SUITE_NAME,
        metric_name: name,
        metric,
        provenance: opts.provenance,
        started_at: startedAt,
        host_machine: hostMachine,
      }),
    );
    recorded.add(name);
  };

  const step = async (names: readonly string[], fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const name of names) {
        if (!recorded.has(name)) {
          record(name, unavailableMetric(`${name} failed: ${message}`));
        }
      }
    }
  };

  const sampleIo = async (): Promise<IoByteCounts | null> => {
    const io = opts.readers?.io;
    if (io === undefined) return null;
    try {
      const sample = await io();
      return validIoSample(sample) ? sample : null;
    } catch {
      return null;
    }
  };

  return {
    opts,
    clock: opts.clock,
    client: opts.client,
    decodeTokens: opts.decodeTokens ?? 64,
    concurrencyWords: opts.concurrencyPromptWords ?? 512,
    rows,
    record,
    step,
    sampleIo,
  };
}

function wordPrompt(tag: string, words: number): string {
  return `${tag} ${"lorem ".repeat(words - 1)}`;
}

async function runLoadHook(
  run: PerfSuiteRun,
  hookName: "cold" | "warm",
  metricName: string,
): Promise<void> {
  await run.step([metricName], async () => {
    const hook = run.opts.load?.[hookName];
    if (hook === undefined) {
      run.record(
        metricName,
        unavailableMetric("no load hooks injected (engine not managed by the suite)"),
      );
      return;
    }
    const t0 = run.clock.now();
    await hook();
    const elapsed = run.clock.now() - t0;
    run.record(
      metricName,
      Number.isFinite(elapsed) && elapsed >= 0
        ? okMetric(elapsed)
        : unavailableMetric("non-finite load time"),
    );
  });
}

async function runLoadPhase(run: PerfSuiteRun): Promise<void> {
  await runLoadHook(run, "cold", "load_cold_ms");
  await runLoadHook(run, "warm", "load_warm_ms");
}

function ctxFromModelsPayload(payload: unknown): number | null {
  const data = asRecord(payload)?.["data"];
  if (!Array.isArray(data)) return null;
  const entry = asRecord((data as unknown[])[0]);
  if (entry === null) return null;
  const meta = asRecord(entry["meta"]);
  // meta.n_ctx_train is only an upper bound for the served -c; any
  // overshoot is caught by step isolation when the engine rejects.
  const candidates = [
    entry["context_length"],
    entry["max_model_len"],
    meta?.["n_ctx"],
    meta?.["n_ctx_train"],
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
  }
  return null;
}

async function resolveModelCtx(run: PerfSuiteRun): Promise<number | null> {
  const explicit = run.opts.ctx ?? null;
  if (explicit !== null && explicit > 0) return explicit;
  const fromProvenance = run.opts.provenance.ctx;
  if (fromProvenance !== null && fromProvenance > 0) return fromProvenance;
  try {
    return ctxFromModelsPayload(await run.client.listModels());
  } catch {
    return null;
  }
}

async function buildTokenExactPrompt(
  client: PerfEngineClient,
  tokens: number,
): Promise<string | null> {
  const filler = wordPrompt(`perf-${String(tokens)}`, tokens + 16);
  const first = await client.tokenize(filler);
  if (first.length < tokens) return null;
  const prompt = first
    .slice(0, tokens)
    .map((token) => token.piece)
    .join("");
  const second = await client.tokenize(prompt);
  return second.length === tokens ? prompt : null;
}

function prefillMetric(stream: PerfStreamResult, tokens: number): MetricValue {
  if (stream.ttftMs === null) return normalisePrefillTps(stream.final);
  return normalisePrefillTps(stream.final, { promptTokens: tokens, ttftMs: stream.ttftMs });
}

async function runPrefillSize(
  run: PerfSuiteRun,
  ctx: number | null,
  step: { tokens: number; metricName: string },
): Promise<void> {
  const { tokens, metricName } = step;
  // `tokens` counts content tokens only; BOS/special tokens are excluded
  // (the engine's own prompt_tokens count may differ by a few).
  await run.step([metricName], async () => {
    if (ctx === null) {
      run.record(metricName, unavailableMetric("model context unknown"));
      return;
    }
    // The token-exact build runs before the context guard so a missing or
    // broken tokenize endpoint reports uniformly across every prefill
    // size instead of being masked by the context bound on large N.
    const prompt = await buildTokenExactPrompt(run.client, tokens);
    if (prompt === null) {
      run.record(metricName, unavailableMetric("could not build a token-exact prompt"));
      return;
    }
    if (tokens + run.decodeTokens > ctx) {
      run.record(
        metricName,
        unavailableMetric(`prefill ${String(tokens)} tokens exceeds model context ${String(ctx)}`),
      );
      return;
    }
    const stream = await run.client.streamCompletion({ prompt, maxTokens: 1 });
    if (stream.promptTokens !== null && Math.abs(stream.promptTokens - tokens) > 8) {
      run.record(
        metricName,
        unavailableMetric(
          `engine counted ${String(stream.promptTokens)} prompt tokens for target ${String(tokens)}`,
        ),
      );
      return;
    }
    run.record(metricName, prefillMetric(stream, tokens));
  });
}

async function runPrefillPhase(run: PerfSuiteRun, ctx: number | null): Promise<void> {
  for (const step of PREFILL_STEPS) {
    await runPrefillSize(run, ctx, step);
  }
}

function ttftMetric(ttftMs: number | null): MetricValue {
  if (ttftMs === null || !Number.isFinite(ttftMs) || ttftMs < 0) {
    return unavailableMetric("no streamed token observed");
  }
  return okMetric(ttftMs);
}

async function runDecodePhase(run: PerfSuiteRun): Promise<void> {
  await run.step(["decode_tps", "ttft_ms", "spec_acceptance"], async () => {
    const stream = await run.client.streamChat({
      messages: [{ role: "user", content: DECODE_PROMPT }],
      maxTokens: run.decodeTokens,
    });
    run.record("decode_tps", normaliseDecodeTps(stream.final));
    run.record("ttft_ms", ttftMetric(stream.ttftMs));
    run.record("spec_acceptance", normaliseAcceptance(stream.final));
  });
}

async function runConcurrencyLevel(run: PerfSuiteRun, level: number): Promise<void> {
  const metricName = `c${String(level)}_tps`;
  await run.step([metricName], async () => {
    const slots = run.opts.slots ?? null;
    if (level > 1 && slots === null) {
      run.record(metricName, unavailableMetric("engine slots unknown (slot count not provided)"));
      return;
    }
    if (slots !== null && slots < level) {
      run.record(
        metricName,
        unavailableMetric(`engine slots ${String(slots)} < concurrency ${String(level)}`),
      );
      return;
    }
    const prompt = wordPrompt("perf-concurrency", run.concurrencyWords);
    const t0 = run.clock.now();
    const streams = await Promise.all(
      Array.from({ length: level }, () =>
        run.client.streamChat({
          messages: [{ role: "user", content: prompt }],
          maxTokens: run.decodeTokens,
        }),
      ),
    );
    const elapsedSec = (run.clock.now() - t0) / 1000;
    const totalTokens = streams.reduce((sum, stream) => sum + stream.completionTokens, 0);
    const tps = totalTokens / elapsedSec;
    run.record(
      metricName,
      Number.isFinite(tps) && tps > 0
        ? okMetric(tps)
        : unavailableMetric("no measurable throughput"),
    );
  });
}

async function runConcurrencyPhase(run: PerfSuiteRun): Promise<void> {
  for (const level of CONCURRENCY_LEVELS) {
    await runConcurrencyLevel(run, level);
  }
}

async function runIoPhase(run: PerfSuiteRun, io0: IoByteCounts | null): Promise<void> {
  await run.step(["ssd_read_bytes", "ssd_write_bytes"], async () => {
    const io1 = await run.sampleIo();
    if (io0 === null || io1 === null) {
      const reason = unavailableMetric("no I/O reader for this platform");
      run.record("ssd_read_bytes", reason);
      run.record("ssd_write_bytes", reason);
      return;
    }
    run.record("ssd_read_bytes", okMetric(Math.max(0, io1.readBytes - io0.readBytes)));
    run.record("ssd_write_bytes", okMetric(Math.max(0, io1.writeBytes - io0.writeBytes)));
  });
}

async function readPeakRss(readers: PerfSuiteReaders | undefined): Promise<number | null> {
  const peakRss = readers?.peakRss;
  if (peakRss === undefined) return null;
  try {
    const value = await peakRss();
    return value !== null && Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function readPeakGtt(readers: PerfSuiteReaders | undefined): Promise<MetricValue> {
  const gtt = readers?.gtt;
  if (gtt === undefined) return unavailableMetric("GTT counters unavailable");
  try {
    const obs = await gtt();
    // GTT is a shared device counter: recorded as-is, never added to RSS.
    if (
      obs !== null &&
      obs.status === "ok" &&
      obs.usedBytes !== null &&
      Number.isFinite(obs.usedBytes) &&
      obs.usedBytes >= 0
    ) {
      return okMetric(obs.usedBytes);
    }
    return unavailableMetric("GTT counters unavailable");
  } catch {
    return unavailableMetric("GTT counters unavailable");
  }
}

async function runMemoryPhase(run: PerfSuiteRun): Promise<void> {
  await run.step(["peak_rss_bytes"], async () => {
    const value = await readPeakRss(run.opts.readers);
    run.record(
      "peak_rss_bytes",
      value === null ? unavailableMetric("no peak-RSS (VmHWM) reader") : okMetric(value),
    );
  });
  await run.step(["peak_gtt_bytes"], async () => {
    run.record("peak_gtt_bytes", await readPeakGtt(run.opts.readers));
  });
}

export async function runPerfSuite(db: Database, opts: PerfSuiteOptions): Promise<PerfRunRow[]> {
  const run = createPerfSuiteRun(db, opts);
  const io0 = await run.sampleIo();
  await runLoadPhase(run);
  const ctx = await resolveModelCtx(run);
  await runPrefillPhase(run, ctx);
  await runDecodePhase(run);
  await runConcurrencyPhase(run);
  await runIoPhase(run, io0);
  await runMemoryPhase(run);
  return run.rows;
}
