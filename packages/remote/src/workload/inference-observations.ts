import type { ResolvedEnv } from "@llamactl/core/types";

import { resolveEnv } from "@llamactl/core/env";
import {
  listLocalRoutes,
  type LocalRoute,
  workloadRuntimeDir,
  workloadRuntimeRoot,
} from "@llamactl/core/workloadRuntime";
import {
  type NodeMemSnapshot,
  probeNodeMem,
  readEngineMetrics,
  readSlotProgress,
  type SlotProgress,
} from "@llamactl/fleet-supervisor";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";

import { constants, open, realpath } from "../safe-fs.js";
import { readKapitsaObservation } from "./kapitsa-observations.js";
import { type ObservedModels, readObservedModels } from "./observed-models.js";

export interface InferenceObservationDeps {
  processEnv?: NodeJS.ProcessEnv;
  listRoutes?: (env: ResolvedEnv) => LocalRoute[];
  probeMemory?: () => Promise<NodeMemSnapshot>;
  fetch?: typeof globalThis.fetch;
}

export interface InferenceRun {
  id: string | null;
  at: string | null;
  state: "completed" | "failed" | "cancelled";
  promptN: number | null;
  cachedN: number | null;
  generatedN: number | null;
  prefillTps: number | null;
  decodeTps: number | null;
  ttftMs: number | null;
  engineFirstMs?: number | null;
  queueMs: number | null;
  durationMs: number | null;
}

export interface ModelCapacity {
  slots: number;
  context: number | null;
}

interface WorkloadObservation {
  workload: string;
  slots: SlotProgress[] | null;
  capacity: ModelCapacity | null;
  queued: number | null;
  waiting?: number;
  allocatedBytes?: number | null;
  kvBytes?: number | null;
  source?: "kapitsa-control";
  runs: InferenceRun[] | null;
}

export interface InferenceObservations {
  sampledAt: string;
  nodeMemory: NodeMemSnapshot;
  workloads: WorkloadObservation[];
  externalModels?: ObservedModels;
}

const MAX_LOG_BYTES = 256 * 1024;
const MAX_RUNS = 50;
const KAPITSA_RUN =
  /^\[kapitsa\] chat: prompt (\d+) \(cached (\d+)\) in ([\d.]+) ms[^\n]*?, (\d+) tokens in [\d.]+ ms \(([\d.]+) tok\/s\), ([a-z_]+)/;
const GUFO_RUN =
  /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[[A-Z]+\] \[http\] request=(r\d+) event=completed method=POST path=\/v1\/chat\/completions (.*)$/;

function asNumber(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseRun(line: string): InferenceRun | null {
  const kapitsa = KAPITSA_RUN.exec(line);
  if (kapitsa !== null) {
    const promptN = asNumber(kapitsa[1]);
    const cachedN = asNumber(kapitsa[2]);
    const prefillMs = asNumber(kapitsa[3]);
    return {
      id: null,
      at: null,
      state: /^(?:stop|length|tool_calls)$/.test(kapitsa[6] ?? "") ? "completed" : "failed",
      promptN,
      cachedN,
      generatedN: asNumber(kapitsa[4]),
      prefillTps:
        promptN !== null && cachedN !== null && prefillMs && promptN > cachedN
          ? ((promptN - cachedN) * 1000) / prefillMs
          : null,
      decodeTps: asNumber(kapitsa[5]),
      ttftMs: null,
      queueMs: null,
      durationMs: null,
    };
  }

  const gufo = GUFO_RUN.exec(line);
  if (gufo === null) return null;
  const fields = new Map(
    [...(gufo[3] ?? "").matchAll(/(?:^| )([a-z_]+)=([^ ]+)/g)].map((match) => [match[1], match[2]]),
  );
  const status = asNumber(fields.get("status"));
  return {
    id: gufo[2] ?? null,
    at: gufo[1] ?? null,
    state:
      status !== null && status >= 200 && status < 300 && fields.get("outcome") === "completed"
        ? "completed"
        : "failed",
    promptN: asNumber(fields.get("prompt_tokens")),
    cachedN: asNumber(fields.get("cached_tokens")),
    generatedN: asNumber(fields.get("generated_tokens")),
    prefillTps: asNumber(fields.get("prefill_tps")),
    decodeTps: asNumber(fields.get("decode_tps")),
    ttftMs: asNumber(fields.get("ttft_ms")),
    queueMs: asNumber(fields.get("queue_ms")),
    durationMs: asNumber(fields.get("duration_ms")),
  };
}

export function parseInferenceRuns(lines: readonly string[]): InferenceRun[] {
  const runs: InferenceRun[] = [];
  for (let index = lines.length - 1; index >= 0 && runs.length < MAX_RUNS; index -= 1) {
    const run = parseRun(lines[index] ?? "");
    if (run !== null) runs.push(run);
  }
  return runs;
}

async function readRecentRuns(
  runtimeRoot: string,
  directory: string,
): Promise<InferenceRun[] | null> {
  try {
    const [root, dir] = await Promise.all([realpath(runtimeRoot), realpath(directory)]);
    const relativeDir = relative(root, dir);
    if (relativeDir.startsWith("..") || isAbsolute(relativeDir)) return null;
    const file = await open(
      join(dir, "modelhost.boot.log"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile()) return null;
      const length = Math.min(stat.size, MAX_LOG_BYTES);
      const start = stat.size - length;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, start);
      const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
      lines.pop();
      if (start > 0) lines.shift();
      return parseInferenceRuns(lines);
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

const KapitsaModel = z.object({
  active: z.literal(true),
  slots: z.number().int().positive(),
  context_length: z.number().int().positive(),
});

async function readKapitsaCapacity(
  endpoint: URL,
  model: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<ModelCapacity | null> {
  try {
    if (endpoint.hostname !== "127.0.0.1" && endpoint.hostname !== "[::1]") return null;
    const response = await fetchImpl(new URL(`/v1/models/${encodeURIComponent(model)}`, endpoint), {
      redirect: "error",
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return null;
    const data = KapitsaModel.safeParse(await response.json());
    return data.success ? { slots: data.data.slots, context: data.data.context_length } : null;
  } catch {
    return null;
  }
}

function redirectErrorFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return ((input, init) =>
    fetchImpl(input, { ...init, redirect: "error" })) as typeof globalThis.fetch;
}

async function observeHttpWorkload(
  env: ResolvedEnv,
  route: LocalRoute,
  dir: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<WorkloadObservation> {
  const host =
    route.host.includes(":") && !route.host.startsWith("[") ? `[${route.host}]` : route.host;
  const endpoint = new URL(`http://${host}:${String(route.port)}`);
  const options = { timeoutMs: 1200, fetch: redirectErrorFetch(fetchImpl) };
  const [slots, metrics, runs, kapitsaCapacity] = await Promise.all([
    readSlotProgress(endpoint.origin, options),
    readEngineMetrics(endpoint.origin, options),
    route.kind === "ModelHost" ? readRecentRuns(workloadRuntimeRoot(env), dir) : null,
    route.engine === "kapitsa" ? readKapitsaCapacity(endpoint, route.model, fetchImpl) : null,
  ]);
  const contexts = new Set(slots.slots.map((slot) => slot.context));
  const capacity =
    kapitsaCapacity ??
    (slots.available
      ? {
          slots: slots.slots.length,
          context: contexts.size === 1 ? (slots.slots[0]?.context ?? null) : null,
        }
      : null);
  return {
    workload: route.workload,
    slots: slots.available && slots.slots.length <= 128 ? slots.slots : null,
    capacity,
    queued: metrics.metrics.requestsDeferred,
    runs,
  };
}

async function observeWorkload(
  env: ResolvedEnv,
  route: LocalRoute,
  fetchImpl: typeof globalThis.fetch,
): Promise<WorkloadObservation> {
  const dir = workloadRuntimeDir(env, { name: route.workload });
  if (route.engine === "kapitsa") {
    const native = await readKapitsaObservation(dir, route.port, route.model);
    if (native !== null) {
      return {
        workload: route.workload,
        slots: native.slots,
        capacity: native.capacity,
        queued: null,
        waiting: native.waiting,
        allocatedBytes: native.allocatedBytes,
        kvBytes: native.kvBytes,
        source: "kapitsa-control",
        runs:
          native.runs.length > 0
            ? native.runs
            : await readRecentRuns(workloadRuntimeRoot(env), dir),
      };
    }
  }
  return await observeHttpWorkload(env, route, dir, fetchImpl);
}

export async function inferenceObservations(
  deps: InferenceObservationDeps = {},
): Promise<InferenceObservations> {
  const source = deps.processEnv ?? process.env;
  const env = resolveEnv(source);
  const listRoutes = deps.listRoutes ?? listLocalRoutes;
  const probeMemory = deps.probeMemory ?? ((): Promise<NodeMemSnapshot> => probeNodeMem());
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sampledAt = new Date().toISOString();
  const workloads = new Map(listRoutes(env).map((route) => [route.workload, route]));
  const observations = Promise.all(
    [...workloads.values()].map((route) => observeWorkload(env, route, fetchImpl)),
  );
  const [nodeMemory, rows, externalModels] = await Promise.all([
    probeMemory(),
    observations,
    readObservedModels(
      source["LLAMACTL_OBSERVED_MODELS_FILE"],
      join(env.LOCAL_AI_RUNTIME_DIR, "observed-models.json"),
    ),
  ]);
  return { sampledAt, nodeMemory, workloads: rows, externalModels };
}
