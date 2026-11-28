import type { ManagedCapacitySample } from "@llamactl/core/resources/managed-capacity";
import type { SwapCounterSample } from "@llamactl/core/resources/memory";

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  type HardwareProcessProbeOptions,
  type HardwareProcessProbePlan,
  runHardwareProcessProbe,
} from "../../src/residency/hardware-process-probe.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "../../src/safe-fs.js";

const GiB = 1024 ** 3;
const roots: string[] = [];
const SERVER = `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "serve") args.shift();
const options = new Map();
for (let i = 0; i < args.length; i += 2) options.set(args[i], args[i+1]);
const port = Number(options.get("--port"));
const artifact = options.get(backend === "omlx" ? "--model-dir" : "--model");
const resolved = backend === "omlx" ? artifact + "/fixture/model.bin" : backend === "kapitsa" ? artifact + "/model.bin" : artifact;
if (typeof artifact !== "string" || await Bun.file(resolved).text() !== "model fixture") process.exit(1);
if (backend === "omlx" && options.get("--max-concurrent-requests") !== "1") process.exit(1);
if (backend === "kapitsa" && (options.get("--slots") !== "1" || !process.env.KAPITSA_HOME)) process.exit(1);
if (mode === "fail") process.exit(1);
if (mode === "orphan") {
  Bun.spawn(["/bin/sleep", "4"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  process.exit(1);
}
if (mode === "extra") Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
let delayed = false;
Bun.serve({
  hostname: options.get("--host"), port,
  async fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") return Response.json({ data: [{ id: "fixture" }] });
    if (mode === "slow" && !delayed) { delayed = true; await Bun.sleep(1600); }
    const body = await req.json();
    if (body.model !== "fixture" || body.max_tokens !== 8) return Response.json({}, { status: 400 });
    return new Response([
      'data: {"choices":[{"delta":{"role":"assistant"}}]}',
      'data: {"model":"fixture","choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}',
      'data: {"choices":[],"usage":{"completion_tokens":1}}',
      mode === "truncate" ? ': transport ended' : 'data: [DONE]',
      ''
    ].join("\\n\\n"), { headers: { "content-type": "text/event-stream" } });
  },
});
`;

type Mode = "fail" | "extra" | "slow" | "truncate" | "orphan" | "good";

function plan(
  mode: Mode = "good",
  backend: HardwareProcessProbePlan["backend"] = "llamacpp",
): HardwareProcessProbePlan {
  const root = mkdtempSync(join(tmpdir(), "llamactl-hardware-fixture-"));
  roots.push(root);
  const binary = join(root, "fixture-engine");
  const content = "model fixture";
  const artifact = join(root, backend === "llamacpp" ? "model.gguf" : "bundle");
  const modelFile = backend === "omlx" ? "fixture/model.bin" : "model.bin";
  const body = SERVER.replace(
    "#!/usr/bin/env bun",
    "#!/usr/bin/env bun\nconst mode = " +
      JSON.stringify(mode) +
      ";\nconst backend = " +
      JSON.stringify(backend) +
      ";",
  );
  writeFileSync(binary, body, { mode: 0o700 });
  const payload = backend === "llamacpp" ? artifact : join(artifact, modelFile);
  mkdirSync(dirname(payload), { recursive: true });
  writeFileSync(payload, content, { mode: 0o600 });
  const weightSha = createHash("sha256").update(content).digest("hex");
  const artifactSha256 =
    backend === "llamacpp"
      ? weightSha
      : createHash("sha256")
          .update(JSON.stringify([[modelFile, weightSha]]))
          .digest("hex");
  return {
    binary,
    binarySha256: createHash("sha256").update(body).digest("hex"),
    artifact,
    artifactSha256,
    backend,
    model: "fixture",
    requiredHeadroomGiB: 2,
  };
}

function run(
  input: HardwareProcessProbePlan,
  options: HardwareProcessProbeOptions = {},
): ReturnType<typeof runHardwareProcessProbe> {
  return runHardwareProcessProbe(input, {
    lockDir: join(dirname(input.binary), "lock"),
    ...options,
  });
}

function capacity(override: Partial<ManagedCapacitySample> = {}): ManagedCapacitySample {
  return {
    source: "darwin-vm",
    observedAtMs: Date.now(),
    physicalBytes: 48 * GiB,
    availableBytes: 24 * GiB,
    pressure: "normal",
    scope: { kind: "host-physical" },
    swapUsedBytes: 0,
    ...override,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("dry run evaluates the real managed bound without spawning the runtime", async () => {
  expect(await run(plan(), { readCapacity: capacity })).toMatchObject({
    status: "NOT_RUN",
    admission: { ok: true, launchHeadroomGiB: 12 },
    launched: false,
  });
});

test("occupied swap blocks the run even when physical headroom is sufficient", async () => {
  expect(
    await run(plan(), {
      execute: true,
      readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
    }),
  ).toMatchObject({
    status: "BLOCKED",
    reason: "SwapUsed",
    launched: false,
  });
});

test("a replaced artifact refuses execution", async () => {
  const input = plan();
  writeFileSync(input.artifact, "different model");
  expect(await run(input, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "BLOCKED",
    reason: "ArtifactMismatch",
    launched: false,
  });
});

test("probe measures streamed content and verifies the isolated process released its listener", async () => {
  const evidence = await run(plan(), { execute: true, readCapacity: capacity });
  expect(evidence).toMatchObject({
    status: "PASS",
    launched: true,
    release: { processExited: true, portReleased: true, forced: false },
    requests: [
      { state: "first-request", outputMatched: true, completionTokens: 1 },
      { state: "repeated-request", outputMatched: true, completionTokens: 1 },
      { state: "repeated-request", outputMatched: true, completionTokens: 1 },
      { state: "repeated-request", outputMatched: true, completionTokens: 1 },
    ],
  });
});

test("a failed launch still verifies release and preserves a failed result", async () => {
  const input = plan("fail");
  expect(await run(input, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "FAIL",
    reason: "EngineExited",
    launched: true,
    release: { processExited: true, portReleased: true },
  });
});

test("the launch boundary rechecks current memory after hashing", async () => {
  let reads = 0;
  expect(
    await run(plan(), {
      execute: true,
      readCapacity: () => capacity(reads++ === 0 ? {} : { availableBytes: 13 * GiB }),
    }),
  ).toMatchObject({
    status: "BLOCKED",
    launched: false,
    reason: "InsufficientHeadroom",
    capacity: [{ availableBytes: 24 * GiB }, { availableBytes: 13 * GiB }],
  });
});

test("swap appearing during real inference cancels the request and releases the process", async () => {
  const input = plan("slow");
  let reads = 0;
  expect(
    await run(input, {
      execute: true,
      readCapacity: () => capacity(reads++ < 2 ? {} : { swapUsedBytes: GiB }),
    }),
  ).toMatchObject({
    status: "FAIL",
    launched: true,
    reason: "SwapUsed",
    requests: [],
    release: { processExited: true, portReleased: true, forced: false },
    afterRelease: { swapUsedBytes: GiB },
  });
});

test("visible output without a terminal stream marker cannot qualify", async () => {
  const input = plan("truncate");
  expect(await run(input, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "FAIL",
    reason: "IncompleteCompletion",
    requests: [],
    release: { processExited: true, portReleased: true },
  });
});

test("extra listeners fail before the model is probed", async () => {
  const input = plan("extra");
  expect(await run(input, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "FAIL",
    reason: "UnexpectedListener",
    requests: [],
    release: { processExited: true, portReleased: true },
  });
});

test("a bundle with an unpinned symlink refuses before launching", async () => {
  const input = plan();
  const actual = input.artifact;
  input.artifact += "-bundle";
  mkdirSync(input.artifact);
  symlinkSync(actual, join(input.artifact, "weights.bin"));
  expect(await run(input, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "BLOCKED",
    reason: "UnsupportedArtifactEntry",
    launched: false,
  });
});

test("the final memory probe cannot be followed by a replaced executable launch", async () => {
  const input = plan();
  let reads = 0;
  const result = await run(input, {
    execute: true,
    readCapacity: () => {
      if (++reads === 2) writeFileSync(input.binary, "#!/bin/sh\nexit 0\n");
      return capacity();
    },
  });
  expect(result).toMatchObject({
    status: "BLOCKED",
    reason: "PinnedInputChanged",
    launched: false,
  });
});

test("arbitrary options cannot replace the configured target, cache, or bind", async () => {
  const input = plan();
  const legacy = { ...input, args: ["--host=192.0.2.1"] };
  expect(await run(legacy, { execute: true, readCapacity: capacity })).toMatchObject({
    status: "BLOCKED",
    reason: "InvalidPlan",
    launched: false,
  });
});

test("a concurrent probe cannot launch while the same host lock is held", async () => {
  const input = plan("slow");
  const first = run(input, { execute: true, readCapacity: capacity });
  const second = await run(input, { execute: true, readCapacity: capacity });
  expect(second).toMatchObject({
    status: "BLOCKED",
    reason: "ProbeInProgressOrUnsettled",
    launched: false,
  });
  expect(await first).toMatchObject({ status: "PASS", release: { processExited: true } });
});

test("an unavailable live capacity read aborts and settles the isolated process", async () => {
  const input = plan("slow");
  let reads = 0;
  expect(
    await run(input, {
      execute: true,
      readCapacity: () => {
        if (++reads > 2) throw new Error("capacity observer unavailable");
        return capacity();
      },
    }),
  ).toMatchObject({
    status: "FAIL",
    reason: "CapacityUnknown",
    requests: [],
    release: { processExited: true, portReleased: true },
  });
});

test("even an ambient HTTP proxy cannot receive the probe's readiness or chat request", async () => {
  let proxied = 0;
  const trap = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      proxied += 1;
      return new Response(null, { status: 500 });
    },
  });
  const names = ["http_proxy", "HTTP_PROXY", "no_proxy", "NO_PROXY"] as const;
  const saved = names.map((key) => [key, process.env[key]] as const);
  try {
    process.env["http_proxy"] = trap.url.href;
    process.env["HTTP_PROXY"] = trap.url.href;
    delete process.env["no_proxy"];
    delete process.env["NO_PROXY"];
    expect(await run(plan(), { execute: true, readCapacity: capacity })).toMatchObject({
      status: "PASS",
    });
    expect(proxied).toBe(0);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    await trap.stop(true);
  }
});

test.each(["omlx", "kapitsa"] as const)(
  "the typed %s bundle reaches the exact model using its own listener",
  async (backend) => {
    expect(
      await run(plan("good", backend), { execute: true, readCapacity: capacity }),
    ).toMatchObject({
      backend,
      status: "PASS",
      requests: [
        { outputMatched: true },
        { outputMatched: true },
        { outputMatched: true },
        { outputMatched: true },
      ],
    });
  },
);

test("an unverified surviving group retains the private recovery files and blocks another launch", async () => {
  const input = plan("orphan");
  const options = { execute: true, readCapacity: capacity };
  const lock = join(dirname(input.binary), "lock");
  let recovery: { runDir: string; processGroup: number } | undefined;
  try {
    expect(await run(input, options)).toMatchObject({
      status: "FAIL",
      reason: "EngineExited",
      release: { processExited: false, portReleased: true },
    });
    recovery = JSON.parse(readFileSync(join(lock, "run.json"), "utf8")) as {
      runDir: string;
      processGroup: number;
    };
    expect(existsSync(recovery.runDir)).toBe(true);
    expect(await run(input, options)).toMatchObject({
      status: "BLOCKED",
      reason: "ProbeInProgressOrUnsettled",
      launched: false,
    });
  } finally {
    if (recovery !== undefined) {
      try {
        process.kill(-recovery.processGroup, "SIGTERM");
      } catch {
        /* fixture already exited */
      }
      rmSync(recovery.runDir, { recursive: true, force: true });
    }
  }
});

function swapCounters(swapInBytes = 0, swapOutBytes = 0): SwapCounterSample {
  return { status: "ok", source: "fixture", observedAtMs: Date.now(), swapInBytes, swapOutBytes };
}

test("an explicit ceiling accepts quiet occupied swap in a read-only preflight", async () => {
  expect(
    await run(
      { ...plan(), maxSwapUsedGiB: 3.25 },
      {
        readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
        readSwap: () => Promise.resolve(swapCounters()),
      },
    ),
  ).toMatchObject({
    status: "NOT_RUN",
    launched: false,
    admission: { ok: true, launchHeadroomGiB: 12 },
    existingSwap: { ceilingGiB: 3.25, baselineUsedBytes: 3 * GiB },
    swapIo: { rate: { known: true, swapInBytesPerSec: 0, swapOutBytesPerSec: 0 } },
  });
});

test("a swap ceiling cannot admit unavailable or active swap counters", async () => {
  const input = { ...plan(), maxSwapUsedGiB: 3.25 };
  const readCapacity = (): ManagedCapacitySample => capacity({ swapUsedBytes: 3 * GiB });
  expect(
    await run(input, { readCapacity, readSwap: () => Promise.resolve(undefined) }),
  ).toMatchObject({
    status: "BLOCKED",
    reason: "SwapIoUnknown",
    launched: false,
  });
  let reads = 0;
  expect(
    await run(input, {
      readCapacity,
      readSwap: () => Promise.resolve(swapCounters(0, reads++ * 4096)),
    }),
  ).toMatchObject({
    status: "BLOCKED",
    reason: "SwapIoActive",
    launched: false,
  });
});

test("existing swap does not waive pressure or physical headroom", async () => {
  const input = { ...plan(), maxSwapUsedGiB: 3.25 };
  const readSwap = (): Promise<ReturnType<typeof swapCounters>> => Promise.resolve(swapCounters());
  expect(
    await run(input, {
      readCapacity: () => capacity({ swapUsedBytes: 3 * GiB, pressure: "warning" }),
      readSwap,
    }),
  ).toMatchObject({ status: "BLOCKED", reason: "MemoryPressure", launched: false });
  expect(
    await run(input, {
      readCapacity: () => capacity({ swapUsedBytes: 3 * GiB, availableBytes: 13 * GiB }),
      readSwap,
    }),
  ).toMatchObject({ status: "BLOCKED", reason: "InsufficientHeadroom", launched: false });
});

test("swap activity during an opted-in run aborts the engine and verifies release", async () => {
  let reads = 0;
  expect(
    await run(
      { ...plan("slow"), maxSwapUsedGiB: 3.25 },
      {
        execute: true,
        readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
        readSwap: () => Promise.resolve(swapCounters(++reads > 2 ? 4096 : 0)),
      },
    ),
  ).toMatchObject({
    status: "FAIL",
    reason: "SwapIoActive",
    launched: true,
    requests: [],
    release: { processExited: true, portReleased: true, forced: false },
  });
});

test("occupied swap growth below the approved ceiling still aborts the live probe", async () => {
  let reads = 0;
  expect(
    await run(
      { ...plan("slow"), maxSwapUsedGiB: 3.25 },
      {
        execute: true,
        readCapacity: () => capacity({ swapUsedBytes: 3 * GiB + (reads++ >= 2 ? 4096 : 0) }),
        readSwap: () => Promise.resolve(swapCounters()),
      },
    ),
  ).toMatchObject({
    status: "FAIL",
    reason: "SwapUsedGrew",
    launched: true,
    requests: [],
    release: { processExited: true, portReleased: true, forced: false },
  });
});

test.each([
  {
    condition: "gets a newer quiet sample",
    changeAt: 0,
    newer: true,
    refusal: undefined,
    reads: 2,
  },
  {
    condition: "sees changed counters",
    changeAt: 1,
    newer: true,
    refusal: "SwapIoUnknown",
    reads: 1,
  },
  {
    condition: "gets the same timestamp again",
    changeAt: 0,
    newer: false,
    refusal: "SwapIoUnknown",
    reads: 2,
  },
  {
    condition: "gets a newer active sample",
    changeAt: 2,
    newer: true,
    refusal: "SwapIoActive",
    reads: 2,
  },
])(
  "a swap read repeating the finish timestamp $condition",
  async ({ changeAt, newer, refusal, reads }) => {
    const input = { ...plan(), maxSwapUsedGiB: 3.25 };
    const recovery = join(dirname(input.binary), "lock", "run.json");
    let lastLiveObservation = 0;
    let releasedReads = 0;
    const readSwap = (): Promise<SwapCounterSample> => {
      const { processGroup } = JSON.parse(readFileSync(recovery, "utf8")) as {
        processGroup?: number;
      };
      if (processGroup !== undefined) {
        try {
          process.kill(processGroup, 0);
        } catch {
          releasedReads++;
          return Promise.resolve({
            ...swapCounters(releasedReads === changeAt ? 4096 : 0),
            observedAtMs: lastLiveObservation + (releasedReads === 2 && newer ? 1 : 0),
          });
        }
        lastLiveObservation = Date.now() - 2;
        return Promise.resolve({ ...swapCounters(), observedAtMs: lastLiveObservation });
      }
      return Promise.resolve(swapCounters());
    };

    const evidence = await run(input, {
      execute: true,
      readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
      readSwap,
    });
    expect(evidence).toMatchObject({
      status: refusal === undefined ? "PASS" : "FAIL",
      ...(refusal === undefined ? {} : { reason: refusal }),
      launched: true,
      existingSwap: { ceilingGiB: 3.25, baselineUsedBytes: 3 * GiB },
      release: { processExited: true, portReleased: true, forced: false },
    });
    expect(evidence.requests).toHaveLength(4);
    expect(releasedReads).toBe(reads);
    if (refusal === undefined) {
      expect(evidence.swapIo).toMatchObject({
        after: { observedAtMs: lastLiveObservation + 1 },
        rate: { known: true, swapInBytesPerSec: 0, swapOutBytesPerSec: 0 },
      });
    }
  },
);

test("the execution boundary blocks an opted-in launch if swap becomes active", async () => {
  let reads = 0;
  expect(
    await run(
      { ...plan(), maxSwapUsedGiB: 3.25 },
      {
        execute: true,
        readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
        readSwap: () => Promise.resolve(swapCounters(4096 * reads++)),
      },
    ),
  ).toMatchObject({ status: "BLOCKED", reason: "SwapIoActive", launched: false });
});

test("swap activity in the release samples prevents qualification", async () => {
  const input = { ...plan(), maxSwapUsedGiB: 3.25 };
  const recovery = join(dirname(input.binary), "lock", "run.json");
  let lastLiveObservation = 0;
  const readSwap = (): Promise<SwapCounterSample> => {
    const { processGroup } = JSON.parse(readFileSync(recovery, "utf8")) as {
      processGroup?: number;
    };
    if (processGroup !== undefined) {
      try {
        process.kill(processGroup, 0);
      } catch {
        return Promise.resolve({ ...swapCounters(4096), observedAtMs: lastLiveObservation + 1 });
      }
      lastLiveObservation = Date.now() - 2;
      return Promise.resolve({ ...swapCounters(), observedAtMs: lastLiveObservation });
    }
    return Promise.resolve(swapCounters());
  };
  const evidence = await run(input, {
    execute: true,
    readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
    readSwap,
  });
  expect(evidence.requests).toHaveLength(4);
  expect(evidence).toMatchObject({
    status: "FAIL",
    reason: "SwapIoActive",
    launched: true,
    release: { processExited: true, portReleased: true, forced: false },
  });
});

test("the final capacity read cannot be followed by a launch after new swap I/O", async () => {
  let capacityReads = 0;
  let swapped = false;
  expect(
    await run(
      { ...plan(), maxSwapUsedGiB: 3.25 },
      {
        execute: true,
        readCapacity: () => {
          if (++capacityReads === 2) swapped = true;
          return capacity({ swapUsedBytes: 3 * GiB });
        },
        readSwap: () => Promise.resolve(swapCounters(swapped ? 4096 : 0)),
      },
    ),
  ).toMatchObject({ status: "BLOCKED", reason: "SwapIoActive", launched: false });
});

test("a stalled swap read is bounded and the process is still released", async () => {
  let reads = 0;
  expect(
    await run(
      { ...plan("slow"), maxSwapUsedGiB: 3.25 },
      {
        execute: true,
        readCapacity: () => capacity({ swapUsedBytes: 3 * GiB }),
        readSwap: () =>
          ++reads === 3 ? new Promise<never>(() => undefined) : Promise.resolve(swapCounters()),
      },
    ),
  ).toMatchObject({
    status: "FAIL",
    reason: "SwapIoUnknown",
    launched: true,
    release: { processExited: true, portReleased: true, forced: false },
  });
}, 7000);
