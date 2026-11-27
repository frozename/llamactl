import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { server } from "@llamactl/core";
import { getEngineScopeLauncher, setEngineScopeLauncher } from "@llamactl/core/engines/scope";
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ColdExecutionGroup } from "../../src/server/cold-owner-mount.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import { verifyColdModelArtifactReceipt } from "../../src/residency/cold-artifact-receipt.js";
import {
  createManagedColdModelRunFactory,
  prepareManagedColdModelRun,
} from "../../src/residency/managed-cold-modelrun.js";
import { createManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";
import {
  defaultResidencyStorePath,
  openResidencyOperationStore,
} from "../../src/residency/store.js";
import { openNodeManagedAdmission } from "../../src/residency/target-admission-policy.js";
import { runModelRunStart, ServerStartInputSchema } from "../../src/router.js";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { modelRunStartInvocation } from "../../src/workload/apply.js";
import { ModelRunSchema } from "../../src/workload/schema.js";
import { saveWorkload } from "../../src/workload/store.js";

const MODEL = "fixture.gguf";
const WORKLOAD = "managed-cold-fixture";
const DECLARATION: ColdEngineDispatch["declaration"] = {
  id: MODEL,
  workload: WORKLOAD,
  kind: "ModelRun",
  ownerNodeId: "local",
  autoLoadEligible: true,
  state: "cold",
};
const CAP: ColdExecutionGroup = {
  name: "test-device",
  foregroundPorts: [19000],
  backgroundPorts: [19001],
  foregroundConcurrency: 1,
  maxQueued: 4,
  maxQueuedBytes: 4096,
  maxPerPrincipal: 4,
  maxQueueWaitMs: 2000,
  starvationBoundMs: 2000,
  maxContextTokens: 128,
  maxCompletionTokens: 8,
};

function storedRun(extraArgs: string[] = ["--ctx-size", "256", "--parallel", "2"]): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: WORKLOAD },
    spec: {
      node: "local",
      target: { kind: "rel", value: MODEL },
      binary: "/usr/bin/false",
      endpoint: { host: "127.0.0.1", port: 19000 },
      resources: { expectedMemoryGiB: 4 },
      extraArgs,
    },
  });
}

function fixture(): {
  artifact: Buffer;
  modelPath: string;
  runtimeDir: string;
  workloadsDir: string;
  [Symbol.dispose](): void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-cold-artifact-"));
  const models = join(dir, "models");
  const modelPath = join(models, MODEL);
  const workloadsDir = join(dir, "workloads");
  const runtimeDir = join(dir, "runtime");
  const artifact = Buffer.alloc(48 * 1024, 13);
  mkdirSync(models);
  writeFileSync(modelPath, artifact);
  const env = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_RESIDENCY_STORE: join(dir, "residency.sqlite"),
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMA_CPP_MODELS: models,
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: "19000",
    LLAMA_CPP_CACHE: join(dir, "cache"),
    LLAMA_CPP_LOGS: join(dir, "logs"),
    LLAMA_CPP_USE_TUNED_ARGS: "false",
  };
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return {
    artifact,
    modelPath,
    runtimeDir,
    workloadsDir,
    [Symbol.dispose](): void {
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function compileFixture(): server.PreparedManagedServerStart {
  const { workload, ...input } = modelRunStartInvocation(storedRun());
  const result = server.prepareManagedServerStart({ ...input, key: { name: workload } });
  if ("result" in result) throw new Error(result.result.error);
  return result;
}

test("cold hash preparation streams only a bounded eligible file and binds its pinned generation", async () => {
  using files = fixture();
  const prepared = compileFixture();
  const generationDigest = prepared.launch.artifacts.model.generationDigest;
  const sha256 = createHash("sha256").update(files.artifact).digest("hex");
  const opts = {
    rel: MODEL,
    modelPath: files.modelPath,
    generationDigest,
    sha256,
    eligible: true,
    maxBytes: files.artifact.length,
  };

  expect(await verifyColdModelArtifactReceipt(opts)).toEqual({
    rel: MODEL,
    generationDigest,
    sha256,
  });
  expect(await verifyColdModelArtifactReceipt({ ...opts, eligible: false })).toBeUndefined();
  expect(
    await verifyColdModelArtifactReceipt({ ...opts, maxBytes: files.artifact.length - 1 }),
  ).toBeUndefined();
  expect(await verifyColdModelArtifactReceipt({ ...opts, sha256: "a".repeat(64) })).toBeUndefined();
  const cancel = new AbortController();
  cancel.abort();
  expect(await verifyColdModelArtifactReceipt({ ...opts, signal: cancel.signal })).toBeUndefined();
  writeFileSync(files.modelPath + ".replacement", files.artifact);
  renameSync(files.modelPath + ".replacement", files.modelPath);
  expect(await verifyColdModelArtifactReceipt(opts)).toBeUndefined();
});

test("the proof-consuming factory pins final engine bounds and calls the exact managed launch gate", async () => {
  using files = fixture();
  saveWorkload(storedRun(), files.workloadsDir);
  const prepared = compileFixture();
  const generationDigest = prepared.launch.artifacts.model.generationDigest;
  const sha256 = createHash("sha256").update(files.artifact).digest("hex");
  const receipt = { rel: MODEL, generationDigest, sha256 };
  const gate = mock(() => Promise.resolve({ ran: false as const, detail: "BudgetExceeded" }));
  let targetPolicy = "c".repeat(64);
  const factory = createManagedColdModelRunFactory({
    workloadsDir: files.workloadsDir,
    readDeclarations: () => [DECLARATION],
    readArtifactReceipt: () => receipt,
    readTargetPolicyRevision: () => targetPolicy,
    readResident: () => undefined,
    readReadyRoutes: () => [],
  });
  const owner = factory({ ownerNodeId: "local", managed: { run: gate }, executionGroups: [CAP] });
  if (owner === undefined) throw new Error("expected factory owner");

  const pin = owner.pin(DECLARATION);
  expect(pin?.artifactRevision).toBe(`sha256:${sha256}`);
  expect(pin?.endpoint).toBe("http://127.0.0.1:19000");
  if (pin === undefined) throw new Error("expected exact prepared pin");
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");
  expect(gate).toHaveBeenCalledTimes(1);
  expect(gate).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "ModelRun",
      runtimeKey: WORKLOAD,
      effectiveSpecDigest: prepared.effectiveSpecDigest,
    }),
    expect.any(AbortSignal),
    expect.any(Function),
  );

  targetPolicy = "d".repeat(64);
  expect(owner.pin(DECLARATION)?.policyRevision).not.toBe(pin.policyRevision);
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");
  expect(gate).toHaveBeenCalledTimes(1);
  for (const invalid of [
    ["--ctx-size", "256"],
    ["--ctx-size", "256", "-c", "256", "--parallel", "2"],
    ["--ctx-size", "256junk", "--parallel", "2"],
    ["--ctx-size", "256", "--parallel", "4"],
  ]) {
    saveWorkload(storedRun(invalid), files.workloadsDir);
    expect(owner.pin(DECLARATION)).toBeUndefined();
  }
  saveWorkload(storedRun(), files.workloadsDir);
  expect(owner.pin(DECLARATION)).toBeDefined();
  const insufficientSlots = factory({
    ownerNodeId: "local",
    managed: { run: gate },
    executionGroups: [{ ...CAP, foregroundConcurrency: 3 }],
  });
  expect(insufficientSlots?.pin(DECLARATION)).toBeUndefined();
  writeFileSync(files.modelPath + ".replacement", files.artifact);
  renameSync(files.modelPath + ".replacement", files.modelPath);
  expect(owner.pin(DECLARATION)).toBeUndefined();
});

test("a cold pin binds allocation and canonical profile membership independently of argv", async () => {
  using files = fixture();
  const run = storedRun();
  run.metadata.annotations = { "llamactl.io/residency-profiles": "offline, overnight" };
  saveWorkload(run, files.workloadsDir);
  const prepared = compileFixture();
  const gate = mock(() => Promise.resolve({ ran: false as const, detail: "fixture refusal" }));
  const owner = createManagedColdModelRunFactory({
    workloadsDir: files.workloadsDir,
    readDeclarations: () => [DECLARATION],
    readArtifactReceipt: () => ({
      rel: MODEL,
      generationDigest: prepared.launch.artifacts.model.generationDigest,
      sha256: createHash("sha256").update(files.artifact).digest("hex"),
    }),
    readTargetPolicyRevision: () => "a".repeat(64),
    readResident: () => undefined,
    readReadyRoutes: () => [],
  })({ ownerNodeId: "local", managed: { run: gate }, executionGroups: [CAP] });
  const pin = owner?.pin(DECLARATION);
  if (owner === undefined || pin === undefined) throw new Error("expected fixture pin");

  run.metadata.annotations["llamactl.io/residency-profiles"] = "overnight, offline, overnight";
  saveWorkload(run, files.workloadsDir);
  expect(owner.pin(DECLARATION)?.policyRevision).toBe(pin.policyRevision);

  run.spec.resources = { expectedMemoryGiB: 8 };
  saveWorkload(run, files.workloadsDir);
  expect(owner.pin(DECLARATION)?.policyRevision).not.toBe(pin.policyRevision);
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");

  run.spec.resources = { expectedMemoryGiB: 4 };
  run.metadata.annotations["llamactl.io/residency-profiles"] = "overnight";
  saveWorkload(run, files.workloadsDir);
  expect(owner.pin(DECLARATION)?.policyRevision).not.toBe(pin.policyRevision);
  expect(await owner.activate(pin, new AbortController().signal)).toBe("refused");
  expect(gate).not.toHaveBeenCalled();
});

for (const [name, options] of [
  ["projector path", ["--mmproj", "projector.gguf"]],
  ["inline projector URL", ["--mmproj-url=https://example.invalid/projector.gguf"]],
  ["automatic projector with safe-flag retry", ["--mmproj-auto"]],
  ["draft path", ["-md", "draft.gguf"]],
  ["inline speculative draft", ["--spec-draft-model=draft.gguf"]],
  ["MTP assistant", ["--mtp-head", "assistant.gguf"]],
  ["LoRA adapter", ["--lora", "adapter.gguf"]],
] as const) {
  test(`cold registration refuses an unattested ${name} without changing normal preparation`, () => {
    using files = fixture();
    const run = storedRun(["--ctx-size", "256", "--parallel", "2", ...options]);
    const { workload, ...input } = modelRunStartInvocation(run);
    expect(server.prepareManagedServerStart({ ...input, key: { name: workload } })).toHaveProperty(
      "effectiveSpecDigest",
    );
    expect(prepareManagedColdModelRun(run, [CAP])).toBeUndefined();
  });
}

test("cold registration refuses a split GGUF rel without changing normal preparation", () => {
  using files = fixture();
  const run = storedRun();
  const shard = "fixture-00001-of-00002.gguf";
  renameSync(files.modelPath, join(dirname(files.modelPath), shard));
  run.spec.target = { kind: "rel", value: shard };
  const { workload, ...input } = modelRunStartInvocation(run);
  expect(server.prepareManagedServerStart({ ...input, key: { name: workload } })).toHaveProperty(
    "effectiveSpecDigest",
  );
  expect(prepareManagedColdModelRun(run, [CAP])).toBeUndefined();
});

for (const cause of ["physical headroom", "desired allocation", "cold pin"] as const) {
  test(`changed ${cause} after asynchronous scope resolution refuses the managed spawn`, async () => {
    using files = fixture();
    const run = storedRun();
    saveWorkload(run, files.workloadsDir);
    openResidencyOperationStore({ path: defaultResidencyStorePath() }).close();
    const now = 80_000;
    const GiB = 1024 ** 3;
    let availableGiB = 56;
    let current = true;
    let scopeResolved = false;
    const { admission, authority } = await openNodeManagedAdmission({
      nodeName: "local",
      workloadsDir: files.workloadsDir,
      nowMs: () => now,
      readCapacity: () => ({
        source: "linux-procfs",
        observedAtMs: now,
        physicalBytes: 64 * GiB,
        availableBytes: availableGiB * GiB,
        scope: { kind: "host-physical" },
        pressure: "normal",
        swapUsedBytes: 0,
      }),
    });
    writeFileSync(join(files.runtimeDir, "managed-residency-v1"), "local\n");
    const previousLauncher = getEngineScopeLauncher();
    setEngineScopeLauncher({
      establishTimeoutMs: 1,
      unitSuffix: () => "fixture",
      noteFailure: () => undefined,
      async resolve() {
        await Promise.resolve();
        scopeResolved = true;
        if (cause === "physical headroom") availableGiB = 16;
        else if (cause === "desired allocation") {
          run.spec.resources = { expectedMemoryGiB: 8 };
          saveWorkload(run, files.workloadsDir);
        } else current = false;
        return { ok: false, reason: "not-linux" };
      },
    });
    try {
      const attempts: number[] = [];
      const expected = {
        "physical headroom": "ManagedCapacity: InsufficientHeadroom",
        "desired allocation": "ManagedSpecChanged",
        "cold pin": "ColdPlanChanged",
      }[cause];
      const outcome = await runModelRunStart(
        ServerStartInputSchema.parse({ ...modelRunStartInvocation(run), timeoutSeconds: 1 }),
        new AbortController().signal,
        (event) => {
          if (event.type === "launch") attempts.push(event.pid);
        },
        admission,
        { effectiveSpecDigest: compileFixture().effectiveSpecDigest, stillCurrent: () => current },
      );
      expect(scopeResolved).toBe(true);
      expect(attempts).toEqual([]);
      expect(outcome).toMatchObject({
        ran: true,
        result: { ok: false, pid: null, error: expected },
      });
      expect(authority.snapshot()).toMatchObject([{ state: "uncertain", allocationGiB: 4 }]);
    } finally {
      setEngineScopeLauncher(previousLauncher);
      authority.close();
    }
  });
}

test("policy drift inside the admitted launch scope prevents spawn and keeps the claim charged", async () => {
  using files = fixture();
  saveWorkload(storedRun(), files.workloadsDir);
  const prepared = compileFixture();
  const receipt = {
    rel: MODEL,
    generationDigest: prepared.launch.artifacts.model.generationDigest,
    sha256: createHash("sha256").update(files.artifact).digest("hex"),
  };
  const authority = openAdmissionAuthority({
    storePath: join(files.workloadsDir, "admission.db"),
    budgetGiB: () => 24,
    observe: () => undefined,
    readPidFile: () => undefined,
    owner: { pid: process.pid },
  });
  try {
    let admittedScope = false;
    let readsAfterAdmission = 0;
    let spawned = 0;
    const managed = createManagedLaunchAdmission({
      authority,
      resolve() {
        admittedScope = true;
        return { specDigest: prepared.effectiveSpecDigest, allocationGiB: 4 };
      },
      capture() {
        spawned++;
        return undefined;
      },
    });
    const owner = createManagedColdModelRunFactory({
      workloadsDir: files.workloadsDir,
      readDeclarations: () => [DECLARATION],
      readArtifactReceipt: () => receipt,
      readTargetPolicyRevision: () => {
        if (!admittedScope) return "a".repeat(64);
        readsAfterAdmission++;
        return "b".repeat(64);
      },
      readResident: () => undefined,
      readReadyRoutes: () => [],
    })({ ownerNodeId: "local", managed, executionGroups: [CAP] });
    const pin = owner?.pin(DECLARATION);
    if (owner === undefined || pin === undefined) throw new Error("expected approved fixture pin");
    expect(await owner.activate(pin, new AbortController().signal)).toBe("uncertain");
    expect(readsAfterAdmission).toBeGreaterThan(0);
    expect(spawned).toBe(0);
    expect(authority.snapshot()).toMatchObject([{ state: "uncertain", allocationGiB: 4 }]);
    expect(
      authority.admit({
        kind: "ModelRun",
        runtimeKey: "second-fixture",
        allocationGiB: 21,
        specDigest: "replacement",
      }),
    ).toMatchObject({ kind: "refuse", reason: "BudgetExceeded" });
  } finally {
    authority.close();
  }
});
