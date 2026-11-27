import type { LocalRoute } from "@llamactl/core/workloadRuntime";
import type {
  NodeMemSnapshot,
  SlotProgress,
  SlotProgressReading,
} from "@llamactl/fleet-supervisor";

import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { KapitsaObservation } from "../../src/workload/kapitsa-observations.js";
import type { ObservedModels } from "../../src/workload/observed-models.js";

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "../../src/safe-fs.js";

// mock.module patches live bindings process-wide. Copy the real exports before
// registering seams, then restore them for any test file loaded after this one.
const envReal = { ...(await import("@llamactl/core/env")) };
const runtimeReal = { ...(await import("@llamactl/core/workloadRuntime")) };
const fleetReal = { ...(await import("@llamactl/fleet-supervisor")) };
const kapitsaReal = { ...(await import("../../src/workload/kapitsa-observations.js")) };
const observedReal = { ...(await import("../../src/workload/observed-models.js")) };

type ResolvedEnv = ReturnType<typeof envReal.resolveEnv>;
type EngineMetricsReading = Awaited<ReturnType<typeof fleetReal.readEngineMetrics>>;

const fixture = {
  runtimeDir: "",
  runtimeRoot: "",
  routes: [] as LocalRoute[],
  workloadDirs: new Map<string, string>(),
  slots: { available: false, reason: "fixture unavailable", slots: [] } as SlotProgressReading,
  metrics: {
    available: false,
    reason: "fixture unavailable",
    metrics: {
      promptTokensTotal: null,
      predictedTokensTotal: null,
      requestsProcessing: null,
      requestsDeferred: null,
    },
  } as EngineMetricsReading,
  kapitsaObservation: null as KapitsaObservation | null,
  observedModels: { state: "unconfigured" } as ObservedModels,
  slotEndpoints: [] as string[],
  metricEndpoints: [] as string[],
  kapitsaCalls: [] as { directory: string; port: number; model: string }[],
  observedModelCalls: [] as { override: string | undefined; defaultFile: string | undefined }[],
  useRealProbes: false,
};

function resetFixture(): void {
  fixture.runtimeDir = "";
  fixture.runtimeRoot = "";
  fixture.routes = [];
  fixture.workloadDirs.clear();
  fixture.slots = { available: false, reason: "fixture unavailable", slots: [] };
  fixture.metrics = {
    available: false,
    reason: "fixture unavailable",
    metrics: {
      promptTokensTotal: null,
      predictedTokensTotal: null,
      requestsProcessing: null,
      requestsDeferred: null,
    },
  };
  fixture.kapitsaObservation = null;
  fixture.observedModels = { state: "unconfigured" };
  fixture.slotEndpoints = [];
  fixture.metricEndpoints = [];
  fixture.kapitsaCalls = [];
  fixture.observedModelCalls = [];
  fixture.useRealProbes = false;
}

const resolveEnvMock = (): ResolvedEnv =>
  ({ LOCAL_AI_RUNTIME_DIR: fixture.runtimeDir }) as unknown as ResolvedEnv;
const listLocalRoutesMock = (): LocalRoute[] => fixture.routes;
const workloadRuntimeRootMock = (): string => fixture.runtimeRoot;
const workloadRuntimeDirMock = (_resolved: unknown, key: { name: string }): string =>
  fixture.workloadDirs.get(key.name) ?? join(fixture.runtimeRoot, key.name);
const probeNodeMemMock = (): Promise<NodeMemSnapshot> =>
  Promise.resolve({
    free_mb: 1,
    active_mb: 1,
    inactive_mb: 1,
    wired_mb: 1,
    compressor_mb: 0,
    swap_in: 0,
    swap_out: 0,
  });
const readSlotProgressMock = async (
  endpoint: string,
  options?: Parameters<typeof fleetReal.readSlotProgress>[1],
): Promise<SlotProgressReading> => {
  fixture.slotEndpoints.push(endpoint);
  if (fixture.useRealProbes) return await fleetReal.readSlotProgress(endpoint, options);
  return fixture.slots;
};
const readEngineMetricsMock = async (
  endpoint: string,
  options?: Parameters<typeof fleetReal.readEngineMetrics>[1],
): Promise<EngineMetricsReading> => {
  fixture.metricEndpoints.push(endpoint);
  if (fixture.useRealProbes) return await fleetReal.readEngineMetrics(endpoint, options);
  return fixture.metrics;
};
const readKapitsaObservationMock = (
  directory: string,
  port: number,
  model: string,
): Promise<KapitsaObservation | null> => {
  fixture.kapitsaCalls.push({ directory, port, model });
  return Promise.resolve(fixture.kapitsaObservation);
};
const readObservedModelsMock = (
  override: string | undefined,
  defaultFile?: string,
): Promise<ObservedModels> => {
  fixture.observedModelCalls.push({ override, defaultFile });
  return Promise.resolve(fixture.observedModels);
};

await mock.module("@llamactl/core/env", () => ({ ...envReal, resolveEnv: resolveEnvMock }));
await mock.module("@llamactl/core/workloadRuntime", () => ({
  ...runtimeReal,
  listLocalRoutes: listLocalRoutesMock,
  workloadRuntimeDir: workloadRuntimeDirMock,
  workloadRuntimeRoot: workloadRuntimeRootMock,
}));
await mock.module("@llamactl/fleet-supervisor", () => ({
  ...fleetReal,
  probeNodeMem: probeNodeMemMock,
  readEngineMetrics: readEngineMetricsMock,
  readSlotProgress: readSlotProgressMock,
}));
await mock.module("../../src/workload/kapitsa-observations.js", () => ({
  ...kapitsaReal,
  readKapitsaObservation: readKapitsaObservationMock,
}));
await mock.module("../../src/workload/observed-models.js", () => ({
  ...observedReal,
  readObservedModels: readObservedModelsMock,
}));

const { inferenceObservations } = await import("../../src/workload/inference-observations.js");

afterAll(() => {
  void mock.module("@llamactl/core/env", () => envReal);
  void mock.module("@llamactl/core/workloadRuntime", () => runtimeReal);
  void mock.module("@llamactl/fleet-supervisor", () => fleetReal);
  void mock.module("../../src/workload/kapitsa-observations.js", () => kapitsaReal);
  void mock.module("../../src/workload/observed-models.js", () => observedReal);
});

const tempDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

function useTempRuntime(): string {
  const root = mkdtempSync(join(tmpdir(), "llamactl-inference-observations-"));
  tempDirs.push(root);
  fixture.runtimeDir = join(root, "runtime");
  fixture.runtimeRoot = join(fixture.runtimeDir, "workloads");
  mkdirSync(fixture.runtimeRoot, { recursive: true });
  return root;
}

beforeEach(() => {
  resetFixture();
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function routeFor(
  workload: string,
  options: {
    engine?: LocalRoute["engine"];
    host?: string;
    kind?: LocalRoute["kind"];
    model?: string;
    port?: number;
  } = {},
): LocalRoute {
  return {
    workload,
    model: options.model ?? "fixture-model",
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 18100,
    engine: options.engine ?? "omlx",
    kind: options.kind ?? "ModelHost",
    pid: 4321,
  };
}

function requireWorkload(
  observations: Awaited<ReturnType<typeof inferenceObservations>>,
  name: string,
): Awaited<ReturnType<typeof inferenceObservations>>["workloads"][number] {
  const workload = observations.workloads.find((row) => row.workload === name);
  if (workload === undefined) throw new Error(`missing workload observation for ${name}`);
  return workload;
}

function completionLine(id: string): string {
  return [
    "2026-11-25 15:29:29 [INFO] [http]",
    `request=${id}`,
    "event=completed",
    "method=POST",
    "path=/v1/chat/completions",
    "status=200",
    "duration_ms=1000",
    "outcome=completed",
    "prompt_tokens=100",
    "prefill_tokens=25",
    "generated_tokens=50",
    "ttft_ms=50",
    "prefill_tps=150",
    "decode_tps=100",
    "queue_ms=20",
    "cached_tokens=75",
  ].join(" ");
}

function writeBootLog(directory: string, lines: readonly string[]): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "modelhost.boot.log"), `${lines.join("\n")}\n`);
}

function slotFixture(count: number): SlotProgress[] {
  return Array.from({ length: count }, (_, id) => ({
    id,
    state: 0,
    processing: false,
    nPast: null,
    nDecoded: null,
    context: 4096,
  }));
}

function asFetch(
  implementation: (input: string | Request | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(implementation, { preconnect: globalThis.fetch.preconnect });
}

test("drops the partial first line when reading the 256 KiB boot-log tail", async () => {
  useTempRuntime();
  const directory = join(fixture.runtimeRoot, "tail");
  mkdirSync(directory, { recursive: true });
  const partial = completionLine("r1");
  const complete = completionLine("r2");
  const prefixBytes = 100;
  const fixed = `${"x".repeat(prefixBytes)}${partial}\n${complete}\n`;
  const targetSize = 256 * 1024 + prefixBytes;
  const paddingLength = targetSize - Buffer.byteLength(fixed) - 1;
  expect(paddingLength).toBeGreaterThan(0);
  const content = `${fixed}${"x".repeat(paddingLength)}\n`;
  expect(Buffer.byteLength(content)).toBe(targetSize);
  writeFileSync(join(directory, "modelhost.boot.log"), content);
  fixture.routes = [routeFor("tail")];

  const observations = await inferenceObservations();

  const workload = requireWorkload(observations, "tail");
  expect(workload.runs?.map((run) => run.id)).toEqual(["r2"]);
});

test("refuses boot logs outside the runtime root and symlinked boot-log files", async () => {
  const root = useTempRuntime();
  const outside = join(root, "outside-workload");
  writeBootLog(outside, [completionLine("r3")]);
  const linked = join(fixture.runtimeRoot, "linked");
  mkdirSync(linked, { recursive: true });
  symlinkSync(join(outside, "modelhost.boot.log"), join(linked, "modelhost.boot.log"));
  fixture.workloadDirs.set("escape", outside);
  fixture.routes = [routeFor("escape"), routeFor("linked")];

  const observations = await inferenceObservations();

  expect(requireWorkload(observations, "escape").runs).toBeNull();
  expect(requireWorkload(observations, "linked").runs).toBeNull();
});

test("falls back from the Kapitsa socket to HTTP capacity and the boot log", async () => {
  useTempRuntime();
  const directory = join(fixture.runtimeRoot, "kapitsa");
  writeBootLog(directory, [completionLine("r4")]);
  fixture.slots = { available: true, slots: slotFixture(1) };
  fixture.metrics = {
    available: true,
    metrics: {
      promptTokensTotal: null,
      predictedTokensTotal: null,
      requestsProcessing: null,
      requestsDeferred: 3,
    },
  };
  fixture.routes = [
    routeFor("kapitsa", {
      engine: "kapitsa",
      model: "kapitsa-model",
      port: 18200,
    }),
  ];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetch((input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.pathname).toBe("/v1/models/kapitsa-model");
      return Promise.resolve(Response.json({ active: true, slots: 7, context_length: 8192 }));
    }),
  );
  try {
    const observations = await inferenceObservations();

    const workload = requireWorkload(observations, "kapitsa");
    expect(fixture.kapitsaCalls).toEqual([{ directory, port: 18200, model: "kapitsa-model" }]);
    expect(fetchSpy.mock.calls).toHaveLength(1);
    expect(workload.source).toBeUndefined();
    expect(workload.capacity).toEqual({ slots: 7, context: 8192 });
    expect(workload.queued).toBe(3);
    expect(workload.runs?.map((run) => run.id)).toEqual(["r4"]);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("does not probe a non-loopback workload endpoint", async () => {
  useTempRuntime();
  fixture.useRealProbes = true;
  fixture.routes = [
    routeFor("public", {
      engine: "llamacpp",
      host: "203.0.113.10",
      kind: "ModelRun",
      port: 18123,
    }),
  ];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetch(() => Promise.reject(new Error("unexpected non-loopback probe"))),
  );
  try {
    const observations = await inferenceObservations();

    const workload = requireWorkload(observations, "public");
    expect(workload.slots).toBeNull();
    expect(workload.capacity).toBeNull();
    expect(workload.queued).toBeNull();
    expect(fetchSpy.mock.calls).toHaveLength(0);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("does not fetch Kapitsa model capacity from a private non-loopback host", async () => {
  useTempRuntime();
  fixture.routes = [
    routeFor("private-kapitsa", {
      engine: "kapitsa",
      host: "192.168.1.5",
      model: "kapitsa-model",
      port: 18201,
    }),
  ];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    asFetch(() => Promise.resolve(Response.json({ active: true, slots: 7, context_length: 8192 }))),
  );
  try {
    const observations = await inferenceObservations();

    const workload = requireWorkload(observations, "private-kapitsa");
    expect(fixture.kapitsaCalls).toHaveLength(1);
    expect(fetchSpy.mock.calls).toHaveLength(0);
    expect(workload.capacity).toBeNull();
  } finally {
    fetchSpy.mockRestore();
  }
});

test("retains exactly 128 slots and suppresses a larger slot response", async () => {
  useTempRuntime();
  fixture.routes = [routeFor("slots")];
  fixture.slots = { available: true, slots: slotFixture(129) };
  expect((await inferenceObservations()).workloads[0]?.slots).toBeNull();

  fixture.slots = { available: true, slots: slotFixture(128) };
  const observations = await inferenceObservations();
  expect(requireWorkload(observations, "slots").slots).toHaveLength(128);
});

test("passes the observed-models override or runtime-root default to the reader", async () => {
  useTempRuntime();
  const defaultFile = join(fixture.runtimeDir, "observed-models.json");
  const override = join(fixture.runtimeDir, "custom-observed.json");
  setEnv("LLAMACTL_OBSERVED_MODELS_FILE", undefined);
  await inferenceObservations();
  setEnv("LLAMACTL_OBSERVED_MODELS_FILE", override);
  await inferenceObservations();

  expect(fixture.observedModelCalls).toEqual([
    { override: undefined, defaultFile },
    { override, defaultFile },
  ]);
});
