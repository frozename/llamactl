import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { RESIDENCY_APPLY_PROFILE_FENCE_OWNER } from "../../remote/src/residency/apply-profile.js";
import { openResidencyOperationStore } from "../../remote/src/residency/store.js";
import {
  ensureModelServing,
  listCellRows,
  type ModelSpec,
  runMatrix,
  type WorkloadEval,
} from "../src/index.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "../src/safe-fs.js";

const REFUSAL =
  "residency lifecycle refused GLM-x downloaded -> loading: ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready";
const GLM_REL = "GLM-5.3-Flash-AJ-GGUF/AJ-IQ2_XXS/GLM-5.3-Flash-AJ-IQ2_XXS-00001-of-00002.gguf";
const GROUP = "z13-large-gpu";
const NOW = 1_000_000_000;
const GATE_ENV_KEYS = [
  "LLAMA_CPP_MODELS",
  "LLAMACTL_RESIDENCY_STORE",
  "LOCAL_AI_CUSTOM_CATALOG_FILE",
] as const;

type LaunchRefusal = (model: ModelSpec) => string | null;
type EnsureModelServingWithGate = (
  model: ModelSpec,
  opts?: { launchRefusal?: LaunchRefusal },
) => ReturnType<typeof ensureModelServing>;

const ensureModelServingWithGate = ensureModelServing as unknown as EnsureModelServingWithGate;

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.map((server) => server.stop(true)));
  servers.length = 0;
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-eval-matrix-gate-"));
  dirs.push(dir);
  return dir;
}

function baseModel(overrides: Partial<ModelSpec>): ModelSpec {
  return {
    name: "test",
    gguf_path: "/tmp/none.gguf",
    quant: "Q4",
    family: "test",
    size_params: "1b",
    host: "127.0.0.1",
    port: 65501,
    extra_args: [],
    ...overrides,
  };
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  const port = server.port!;
  await server.stop(true);
  return port;
}

async function fakeManagedModel(name: string): Promise<{ model: ModelSpec; marker: string }> {
  const dir = tempDir();
  const marker = join(dir, "engine-spawned.marker");
  const script = join(dir, "fake-server.sh");
  writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
  chmodSync(script, 0o755);
  const port = await freePort();
  return {
    marker,
    model: baseModel({ name, managed: true, binary: script, port }),
  };
}

function startHealthServer(): ReturnType<typeof Bun.serve> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      if (req.method === "GET" && path === "/health") {
        return new Response("ok");
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error: unknown) {
    return error;
  }
}

function minimalWorkload(name: string, dir: string, judgeModel?: ModelSpec): WorkloadEval {
  const corpusPath = join(dir, "corpus.jsonl");
  writeFileSync(corpusPath, `${JSON.stringify({ prompt: "q", label: "yes" })}\n`);
  return {
    name,
    corpus_path: corpusPath,
    prompt_builder: () => ({ messages: [{ role: "user", content: "q" }] }),
    scorer: () => ({ metrics: { exact_match: 1 }, prediction: "yes", gold: "yes" }),
    ...(judgeModel !== undefined ? { judge_model: judgeModel } : {}),
  };
}

function seedReady(model: string, storePath: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({
      ownerId: RESIDENCY_APPLY_PROFILE_FENCE_OWNER,
      incarnation: "seed",
    });
    for (const to of ["downloaded", "loading", "warming", "ready"] as const) {
      const result = store.transitionResidencyState({
        fenceToken: fence.fenceToken,
        model,
        ...(to === "loading" ? { group: GROUP } : {}),
        to,
        expectedVersion: store.getResidencyState(model)?.version ?? 0,
        nowMs: NOW,
      });
      expect(result.ok).toBe(true);
    }
  } finally {
    store.close();
  }
}

describe("matrix exclusive-group launch refusal (#517)", () => {
  // Kills: deleting the gate in ensureModelServing, or moving it after spawn().
  test("M1 ensureModelServing refuses before spawn and prefixes the refusal", async () => {
    const { model, marker } = await fakeManagedModel("m1-gated-model");
    const calls: ModelSpec[] = [];
    const launchRefusal = (candidate: ModelSpec): string => {
      calls.push(candidate);
      return REFUSAL;
    };

    const error = await rejectionOf(ensureModelServingWithGate(model, { launchRefusal }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`eval matrix: ${REFUSAL}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe(model.name);
    expect(existsSync(marker)).toBe(false);
  });

  // Kills: a gate that is never consulted, or one that refuses on null.
  test("M2 a null launch refusal consults the gate once and still spawns", async () => {
    const { model, marker } = await fakeManagedModel("m2-ungated-model");
    let calls = 0;
    const launchRefusal = (): string | null => {
      calls += 1;
      return null;
    };

    const error = await rejectionOf(ensureModelServingWithGate(model, { launchRefusal }));

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("eval matrix:");
    expect(existsSync(marker)).toBe(true);
  });

  // Kills: consulting the gate before the health ping, which would refuse an already-serving engine.
  test("M3 the health ping adopts a serving engine before the launch gate", async () => {
    const server = startHealthServer();
    const dir = tempDir();
    const marker = join(dir, "engine-spawned.marker");
    const script = join(dir, "fake-server.sh");
    writeFileSync(script, `#!/bin/sh\n: > ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(script, 0o755);
    const model = baseModel({
      name: "m3-adopted-model",
      managed: true,
      binary: script,
      port: server.port!,
    });
    let calls = 0;
    const launchRefusal = (): string => {
      calls += 1;
      return REFUSAL;
    };

    const boot = await ensureModelServingWithGate(model, { launchRefusal });
    expect(boot).toEqual({ owned: false, proc: null });
    expect(calls).toBe(0);

    await server.stop(true);
    const error = await rejectionOf(ensureModelServingWithGate(model, { launchRefusal }));

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`eval matrix: ${REFUSAL}`);
    expect(calls).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });

  // Kills: runMatrix not passing launchRefusal into the model boot (runModelCells).
  test("R1 runMatrix records the model launch refusal as the cell boot error", async () => {
    const { model, marker } = await fakeManagedModel("r1-gated-model");
    const dir = tempDir();
    const workload = minimalWorkload("r1-workload", dir);
    const db = new Database(":memory:");
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const opts = {
        models: [model],
        workloads: [workload],
        db,
        launchRefusal: (candidate: ModelSpec): string | null =>
          candidate.name === model.name ? REFUSAL : null,
      };
      const result = await runMatrix(opts);

      expect(result.cellsWritten).toBe(1);
      const rows = listCellRows(db, { run_id: result.runId });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.errors).toBe(1);
      expect(warnings.join("\n")).toContain(
        `[matrix] failed to boot ${model.name}: eval matrix: ${REFUSAL}`,
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });

  // Kills: runWorkloadCell not passing launchRefusal into the judge boot.
  test("R2 runMatrix records the judge launch refusal as the cell boot error", async () => {
    const server = startHealthServer();
    const dir = tempDir();
    const model = baseModel({
      name: "r2-serving-model",
      managed: false,
      port: server.port!,
    });
    const judge = await fakeManagedModel("r2-gated-judge");
    const workload = minimalWorkload("r2-judged-workload", dir, judge.model);
    const db = new Database(":memory:");
    const warnings: string[] = [];
    const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const opts = {
        models: [model],
        workloads: [workload],
        db,
        launchRefusal: (candidate: ModelSpec): string | null =>
          candidate.name === judge.model.name ? REFUSAL : null,
      };
      await runMatrix(opts);

      expect(warnings.join("\n")).toContain(
        `[matrix] failed to boot judge for ${workload.name}: eval matrix: ${REFUSAL}`,
      );
      expect(existsSync(judge.marker)).toBe(false);
    } finally {
      warnSpy.mockRestore();
      db.close();
    }
  });

  // Kills: keying the gate only on the name, dropping the name fallback, or refusing ungrouped launches.
  test("G1 matrixLaunchRefusal resolves the catalog rel and reads the store gate", async () => {
    const dir = tempDir();
    const modelsDir = join(dir, "models");
    const storePath = join(dir, "residency", "operations.sqlite");
    const customCatalog = join(dir, "curated-models.tsv");
    writeFileSync(customCatalog, "");
    const savedEnv = new Map<string, string | undefined>();
    for (const key of GATE_ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
    }
    process.env["LLAMA_CPP_MODELS"] = modelsDir;
    process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
    process.env["LOCAL_AI_CUSTOM_CATALOG_FILE"] = customCatalog;
    try {
      seedReady("qwen-prod", storePath);
      // The module is absent at base; the catch turns that into an assertion failure below.
      const mod: Record<string, unknown> = await import("../src/matrix/launch-gate.js").catch(
        () => ({}),
      );
      expect(typeof mod["matrixLaunchRefusal"]).toBe("function");
      const matrixLaunchRefusal = mod["matrixLaunchRefusal"] as (model: ModelSpec) => string | null;
      const port = await freePort();
      const glmByPath = baseModel({
        name: "unrelated-name",
        gguf_path: join(modelsDir, GLM_REL),
        port,
      });
      const expected =
        `residency lifecycle refused ${GLM_REL} downloaded -> loading: ` +
        `ExclusiveGroupOccupied: exclusive group z13-large-gpu is held by qwen-prod in state ready`;

      expect(matrixLaunchRefusal(glmByPath)).toBe(expected);
      expect(
        matrixLaunchRefusal(
          baseModel({
            name: GLM_REL,
            gguf_path: join(dir, "outside", "glm.gguf"),
            port,
          }),
        ),
      ).toBe(expected);
      expect(
        matrixLaunchRefusal(
          baseModel({
            name: "unrelated-model",
            gguf_path: join(modelsDir, "unrelated", "model.gguf"),
            port,
          }),
        ),
      ).toBeNull();

      rmSync(storePath, { force: true });
      expect(matrixLaunchRefusal(glmByPath)).toBeNull();
    } finally {
      for (const key of GATE_ENV_KEYS) {
        const value = savedEnv.get(key);
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }
    }
  });
});
