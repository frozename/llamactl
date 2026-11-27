import { server } from "@llamactl/core";
import { expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openAdmissionAuthority } from "../../src/residency/admission-authority.js";
import {
  createManagedLaunchAdmission,
  type ManagedLaunchAdmission,
} from "../../src/residency/managed-launch-admission.js";
import { router } from "../../src/router.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import * as modelHost from "../../src/server/modelhost.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";

function setFixtureEnv(env: Record<string, string>): () => void {
  const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  };
}

function replaceFixtureFile(path: string): void {
  const stat = statSync(path);
  const replacement = `${path}.replacement`;
  writeFileSync(replacement, readFileSync(path), { mode: stat.mode & 0o777 });
  utimesSync(replacement, stat.atime, stat.mtime);
  renameSync(replacement, path);
}

function writeManagedFakeEngine(path: string, port: number, beforeListen = ""): void {
  const program = `
    ${beforeListen}
    const listener = Bun.serve({ hostname: "127.0.0.1", port: ${String(port)}, fetch: () => new Response("ok") });
    process.on("SIGTERM", () => { listener.stop(true); process.exit(0); });
    await new Promise(() => undefined);
  `;
  writeFileSync(
    path,
    `#!/bin/bash\nexec -a llama-server ${JSON.stringify(process.execPath)} -e ${JSON.stringify(program.replaceAll("\n", " "))}\n`,
    { mode: 0o755 },
  );
}

function modelRunEnvironment(dir: string): {
  model: { target: string; binary: string };
  [Symbol.dispose](): void;
} {
  const models = join(dir, "fixture-models");
  mkdirSync(models);
  writeFileSync(join(models, "model.gguf"), "fixture");
  const env = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
    LLAMA_CPP_HOST: "127.0.0.1",
    LLAMA_CPP_PORT: "65534",
    LLAMA_CPP_MODELS: models,
    LLAMA_CPP_CACHE: join(dir, "cache"),
    LLAMA_CPP_LOGS: join(dir, "logs"),
    LLAMA_CPP_USE_TUNED_ARGS: "false",
  };
  const restoreEnv = setFixtureEnv(env);
  return {
    model: { target: "model.gguf", binary: "/usr/bin/false" },
    [Symbol.dispose](): void {
      restoreEnv();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function terminalResults(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const results: unknown[] = [];
  for await (const event of stream) {
    if (typeof event === "object" && event !== null && "type" in event && event.type === "done") {
      results.push("result" in event ? event.result : undefined);
    }
  }
  return results;
}

test("serverStart consults target admission before entering the runtime lifecycle", async () => {
  const run = mock(() =>
    Promise.resolve({ ran: false as const, detail: "test admission refusal" }),
  );
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  using fixture = modelRunEnvironment(mkdtempSync(join(tmpdir(), "managed-router-plan-")));
  const input = { workload: "managed-router-run", ...fixture.model };
  const results = await terminalResults(await caller.serverStart(input));

  expect(run.mock.calls).toHaveLength(1);
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "ModelRun",
      runtimeKey: input.workload,
      launch: input,
    }),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(results).toEqual([
    expect.objectContaining({ ok: false, pid: null, error: "test admission refusal" }),
  ]);
});

test("an invalid ModelRun plan refuses without reserving or creating launch state", async () => {
  using fixture = modelRunEnvironment(mkdtempSync(join(tmpdir(), "managed-router-invalid-")));
  const run = mock(() => Promise.resolve({ ran: false as const, detail: "unexpected admission" }));
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  const events = await caller.serverStart({
    workload: "invalid-managed-run",
    ...fixture.model,
    target: "missing.gguf",
  });
  const results = await terminalResults(events);
  expect(results).toMatchObject([{ ok: false, pid: null }]);
  expect(JSON.stringify(results)).toContain("Model file not found");
  expect(run).not.toHaveBeenCalled();
  expect(existsSync(process.env["LOCAL_AI_RUNTIME_DIR"] ?? "")).toBe(false);
});

test("modelHostStart consults target admission before entering the runtime lifecycle", async () => {
  const run = mock(() =>
    Promise.resolve({ ran: false as const, detail: "test admission refusal" }),
  );
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  const input = { workload: "managed-router-missing-host" };
  const results = await terminalResults(await caller.modelHostStart(input));

  expect(run.mock.calls).toHaveLength(1);
  expect(run).toHaveBeenCalledWith(
    { kind: "ModelHost", runtimeKey: input.workload, launch: input },
    expect.any(AbortSignal),
    expect.any(Function),
  );
  expect(results).toEqual([{ ok: false, pid: null, error: "test admission refusal" }]);
});

test("modelHostStart withholds its runtime terminal event until managed admission settles", async () => {
  const managed: ManagedLaunchAdmission = {
    async run(_request, _signal, start) {
      const runtime = await start(() => undefined);
      if (!runtime.ran) throw new Error(runtime.detail);
      expect(runtime.result).toMatchObject({ ok: false });
      expect("error" in runtime.result && runtime.result.error).toMatch(/refusing to bind/);
      return { ran: false, detail: "target verification failed" };
    },
  };
  const caller = router.createCaller({ managedLaunchAdmission: managed });
  const results = await terminalResults(
    await caller.modelHostStart({
      workload: "managed-terminal",
      manifest: {
        apiVersion: "llamactl/v1",
        kind: "ModelHost",
        metadata: { name: "managed-terminal" },
        spec: {
          engine: "omlx",
          node: "local",
          binary: "/usr/bin/false",
          endpoint: { host: "0.0.0.0", port: 19092 },
          hostedModels: [{ rel: "test-model.gguf" }],
        },
      },
    }),
  );

  expect(results).toEqual([{ ok: false, pid: null, error: "target verification failed" }]);
});

test("authenticated agent starts share one mixed-kind memory budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-launch-router-"));
  using fixture = modelRunEnvironment(dir);
  const authority = openAdmissionAuthority({
    storePath: join(dir, "admission.db"),
    budgetGiB: () => 24,
    observe: () => undefined,
    readPidFile: () => undefined,
    owner: { pid: process.pid },
  });
  const gate = createManagedLaunchAdmission({
    authority,
    resolve: ({ runtimeKey }) => ({ specDigest: runtimeKey, allocationGiB: 8 }),
    capture: () => undefined,
  });
  let agent: RunningAgent | undefined;
  try {
    const occupying = authority.admit({
      kind: "ModelHost",
      runtimeKey: "resident-host",
      specDigest: "host",
      allocationGiB: 24,
    });
    expect(occupying.kind).toBe("admitted");
    const bearer = "managed-launch-fixture";
    agent = startAgentServer({
      tokenHash: createHash("sha256").update(bearer).digest("hex"),
      managedLaunchAdmission: gate,
    });
    for (const [procedure, input] of [
      ["serverStart", { workload: "denied-run", ...fixture.model }],
      [
        "modelHostStart",
        {
          workload: "denied-host",
          manifest: {
            apiVersion: "llamactl/v1",
            kind: "ModelHost",
            metadata: { name: "denied-host" },
            spec: {
              engine: "omlx",
              node: "local",
              binary: "/usr/bin/false",
              endpoint: { host: "127.0.0.1", port: 19092 },
              hostedModels: [{ rel: "test-model.gguf" }],
            },
          },
        },
      ],
    ] as const) {
      const url = new URL(`http://127.0.0.1:${String(agent.port)}/trpc/${procedure}`);
      url.searchParams.set("input", JSON.stringify(input));
      const response = await fetch(url, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
      const results = (await response.text()).split("\n").flatMap((line) => {
        if (!line.startsWith("data: {")) return [];
        const event = JSON.parse(line.slice(6)) as { type?: string; result?: unknown };
        return event.type === "done" ? [event.result] : [];
      });
      expect(results).toEqual([
        expect.objectContaining({
          ok: false,
          pid: null,
          error: "BudgetExceeded: committed 24 GiB plus incoming 8 GiB exceeds budget 24 GiB",
        }),
      ]);
    }
    expect(authority.snapshot().map(({ runtimeKey, state }) => [runtimeKey, state])).toEqual([
      ["resident-host", "pending"],
    ]);
  } finally {
    await agent?.stop();
    authority.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an already canceled caller skips planning and admission", async () => {
  const run = mock(() => Promise.resolve({ ran: false as const, detail: "unexpected admission" }));
  const managed: ManagedLaunchAdmission = { run };
  const caller = router.createCaller(
    { managedLaunchAdmission: managed },
    { signal: AbortSignal.abort() },
  );
  const results = await terminalResults(
    await caller.serverStart({
      workload: "canceled-managed-router",
      target: "missing/model.gguf",
    }),
  );
  expect(results).toEqual([expect.objectContaining({ ok: false, error: "LaunchCanceled" })]);
  expect(run).not.toHaveBeenCalled();
});

test("serverStart publishes ready only after managed admission commits", async () => {
  const endpoint = "http://127.0.0.1:19092";
  const pid = 1234;
  const startSpy = spyOn(server, "prepareManagedServerStart").mockImplementation((opts) => ({
    effectiveSpecDigest: "fixture",
    launch: {
      rel: opts.target,
      modelPath: opts.target,
      binary: "/usr/bin/false",
      args: [],
      tunedProfile: null,
      artifacts: {
        model: { evidence: "filesystem-metadata", generationDigest: "fixture-model" },
        binary: { evidence: "filesystem-metadata", generationDigest: "fixture-binary" },
      },
    },
    artifactRefusal: (): undefined => undefined,
    start: (): Promise<server.StartServerResult> => {
      opts.onEvent?.({ type: "ready", pid, endpoint });
      return Promise.resolve({
        ok: true,
        pid,
        endpoint,
        advertisedEndpoint: endpoint,
        tunedProfile: null,
        retried: false,
      });
    },
  }));
  try {
    const input = { workload: "managed-run", target: "missing/model.gguf" };
    for (const accepted of [true, false]) {
      const managed: ManagedLaunchAdmission = {
        async run(_request, _signal, start) {
          const result = await start(() => undefined);
          return accepted ? result : { ran: false, detail: "claim commit failed" };
        },
      };
      const stream = await router
        .createCaller({ managedLaunchAdmission: managed })
        .serverStart(input);
      const types: string[] = [];
      for await (const event of stream) types.push(event.type);
      expect(types).toEqual(accepted ? ["ready", "done"] : ["done"]);
    }
  } finally {
    startSpy.mockRestore();
  }
});

test("managed ModelHost reservation names a pinned manifest and runtime environment", async () => {
  const before = process.env["LLAMA_CPP_MODELS"];
  const initialRoot = "/fixture/models-before";
  process.env["LLAMA_CPP_MODELS"] = initialRoot;
  const startSpy = spyOn(modelHost, "startModelHost").mockImplementation(() =>
    Promise.resolve({ ok: true, pid: 4403 }),
  );
  let digest: string | undefined;
  const managed: ManagedLaunchAdmission = {
    async run(request, _signal, start) {
      digest = request.effectiveSpecDigest;
      expect(request.effectiveLaunch).toMatchObject({
        modelsDir: initialRoot,
        hostedModels: [{ rel: "before.gguf" }],
      });
      process.env["LLAMA_CPP_MODELS"] = "/fixture/models-after";
      const mutable = request.launch["manifest"] as { spec: { hostedModels: { rel: string }[] } };
      mutable.spec.hostedModels[0]!.rel = "after.gguf";
      return await start(() => undefined);
    },
  };

  try {
    const caller = router.createCaller({ managedLaunchAdmission: managed });
    await terminalResults(
      await caller.modelHostStart({
        workload: "pinned-host",
        manifest: {
          apiVersion: "llamactl/v1",
          kind: "ModelHost",
          metadata: { name: "pinned-host" },
          spec: {
            engine: "llamacpp",
            node: "local",
            binary: "/usr/bin/false",
            endpoint: { host: "127.0.0.1", port: 19092 },
            hostedModels: [{ rel: "before.gguf" }],
          },
        },
      }),
    );
    const opts = startSpy.mock.calls[0]?.[0];
    expect(opts?.manifest).toMatchObject({ spec: { hostedModels: [{ rel: "before.gguf" }] } });
    expect(opts?.env?.["LLAMA_CPP_MODELS"]).toBe(initialRoot);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    startSpy.mockRestore();
    if (before === undefined) delete process.env["LLAMA_CPP_MODELS"];
    else process.env["LLAMA_CPP_MODELS"] = before;
  }
});

test("workloadApply keeps the target admission gate through the local client", async () => {
  const run = mock(() =>
    Promise.resolve({ ran: false as const, detail: "fixture-managed-budget" }),
  );
  const startSpy = spyOn(modelHost, "startModelHost").mockImplementation(() =>
    Promise.resolve({ ok: false, pid: null, error: "unexpected unmanaged start" }),
  );
  try {
    const caller = router.createCaller({ managedLaunchAdmission: { run } });
    const result = caller.workloadApply({
      yaml: `
apiVersion: llamactl/v1
kind: ModelHost
metadata:
  name: managed-local-apply
spec:
  engine: llamacpp
  node: local
  binary: /usr/bin/false
  hostedModels:
    - rel: fake.gguf
  endpoint:
    host: 127.0.0.1
    port: 19106
  resources:
    expectedMemoryGiB: 1
`,
    });
    const failure = await result.catch((error: unknown) => error);
    expect(failure instanceof Error ? failure.message : "").toContain("fixture-managed-budget");
    expect(run).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
  } finally {
    startSpy.mockRestore();
  }
});

test("managed ModelRun launches the pinned target, args and child environment after admission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-modelrun-plan-"));
  const firstModels = join(dir, "first-models");
  const secondModels = join(dir, "second-models");
  const childInput = join(dir, "child-input.json");
  const bin = join(dir, "fake-llama-server");
  const reserver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(reserver.port);
  await reserver.stop(true);
  mkdirSync(firstModels);
  mkdirSync(secondModels);
  writeFileSync(join(firstModels, "fixture.gguf"), "fixture");
  writeFileSync(join(secondModels, "fixture.gguf"), "replacement");
  writeManagedFakeEngine(
    bin,
    port,
    `await Bun.write(${JSON.stringify(childInput)}, JSON.stringify({ inherited: process.env["PLAN_TEST_ENGINE_ENV"] }));`,
  );
  const env = {
    DEV_STORAGE: dir,
    LOCAL_AI_RUNTIME_DIR: join(dir, "runtime"),
    LLAMACTL_WORKLOADS_DIR: join(dir, "workloads"),
    LLAMA_CPP_MODELS: firstModels,
    LLAMA_CPP_CACHE: join(dir, "cache"),
    LLAMA_CPP_LOGS: join(dir, "logs"),
    LLAMA_CPP_SERVER_ALIAS: "admitted-alias",
    LLAMA_CPP_USE_TUNED_ARGS: "false",
    PLAN_TEST_ENGINE_ENV: "admitted-value",
  };
  const restoreEnv = setFixtureEnv(env);
  let pid: number | undefined;
  let digest: string | undefined;
  let claimedDigest: string | undefined;
  let effectiveArgs: unknown;
  const authority = openAdmissionAuthority({
    storePath: join(dir, "admission.db"),
    budgetGiB: () => 24,
    observe: () => undefined,
    readPidFile: () => undefined,
    owner: { pid: process.pid },
  });
  const managed = createManagedLaunchAdmission({
    authority: {
      ...authority,
      admit: (request) => {
        claimedDigest = request.specDigest;
        return authority.admit(request);
      },
    },
    resolve: (request) => {
      if (digest === undefined) {
        expect(existsSync(env.LLAMA_CPP_LOGS)).toBe(false);
        expect(existsSync(env.LOCAL_AI_RUNTIME_DIR)).toBe(false);
      }
      digest = request.effectiveSpecDigest;
      effectiveArgs = request.effectiveLaunch?.["args"];
      expect(request.effectiveLaunch?.["modelPath"]).toBe(join(firstModels, "fixture.gguf"));
      process.env["LLAMA_CPP_MODELS"] = secondModels;
      process.env["LLAMA_CPP_SERVER_ALIAS"] = "changed-alias";
      process.env["PLAN_TEST_ENGINE_ENV"] = "changed-value";
      return { specDigest: "raw-resolver-digest", allocationGiB: 16 };
    },
    capture: (_request, capturedPid) => ({ pid: capturedPid, startTimeMs: 100 }),
  });
  try {
    const events = await router.createCaller({ managedLaunchAdmission: managed }).serverStart({
      workload: "managed-pinned-run",
      target: "fixture.gguf",
      binary: bin,
      endpoint: { host: "127.0.0.1", port },
      timeoutSeconds: 5,
    });
    let args: string[] = [];
    for await (const event of events) {
      if (event.type === "launch") {
        pid = event.pid;
        args = event.args;
      }
      if (event.type === "done") expect(event.result.ok).toBe(true);
    }
    expect(args.slice(0, 4)).toEqual([
      "-m",
      join(firstModels, "fixture.gguf"),
      "--alias",
      "admitted-alias",
    ]);
    expect(effectiveArgs).toEqual(args);
    expect(readFileSync(childInput, "utf8")).toBe('{"inherited":"admitted-value"}');
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(claimedDigest).toBe(digest);
    expect(authority.snapshot()).toMatchObject([{ state: "resident", specDigest: digest }]);
  } finally {
    authority.close();
    if (pid !== undefined && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("managed ModelRun rejects a second model path before admission", async () => {
  using fixture = modelRunEnvironment(mkdtempSync(join(tmpdir(), "managed-artifact-override-")));
  const run = mock(() => Promise.resolve({ ran: false as const, detail: "unexpected admission" }));
  const caller = router.createCaller({ managedLaunchAdmission: { run } });
  const events = await caller.serverStart({
    ...fixture.model,
    workload: "managed-override",
    extraArgs: ["--model=/tmp/another-model.gguf"],
  });
  expect(JSON.stringify(await terminalResults(events))).toContain(
    "ManagedModelOverrideUnavailable",
  );
  expect(run).not.toHaveBeenCalled();
});

test.each(["model", "binary"] as const)(
  "managed ModelRun refuses a replaced %s at the approved path",
  async (artifact) => {
    const dir = mkdtempSync(join(tmpdir(), "managed-run-artifact-"));
    using fixture = modelRunEnvironment(dir);
    const marker = join(dir, "engine-spawned");
    const binary = join(dir, "llama-server");
    writeFileSync(binary, `#!/bin/sh\nprintf spawned > ${JSON.stringify(marker)}\n`, {
      mode: 0o755,
    });
    const artifactPath =
      artifact === "binary" ? binary : join(dir, "fixture-models", fixture.model.target);
    const authority = openAdmissionAuthority({
      storePath: join(dir, "admission.db"),
      budgetGiB: () => 24,
      observe: () => undefined,
      readPidFile: () => undefined,
      owner: { pid: process.pid },
    });
    const gate = createManagedLaunchAdmission({
      authority: {
        ...authority,
        admit: (request) => {
          const claim = authority.admit(request);
          replaceFixtureFile(artifactPath);
          return claim;
        },
      },
      resolve: () => ({ specDigest: "resolver-digest", allocationGiB: 16 }),
      capture: () => undefined,
    });
    try {
      const caller = router.createCaller({ managedLaunchAdmission: gate });
      const events = await caller.serverStart({
        ...fixture.model,
        workload: "artifact-check",
        binary,
        timeoutSeconds: 1,
      });
      const results = await terminalResults(events);
      expect(JSON.stringify(results)).toContain(`ManagedArtifactChanged: ${artifact}`);
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(join(dir, "runtime"))).toBe(false);
      expect(authority.snapshot()).toEqual([]);
    } finally {
      authority.close();
    }
  },
);

test("managed ModelRun rechecks artifacts after the async scope decision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-run-artifact-scope-"));
  using fixture = modelRunEnvironment(dir);
  const marker = join(dir, "engine-spawned");
  const binary = join(dir, "llama-server");
  writeFileSync(binary, `#!/bin/sh\nprintf spawned > ${JSON.stringify(marker)}\n`, { mode: 0o755 });
  const model = join(dir, "fixture-models", fixture.model.target);
  const prepared = server.prepareManagedServerStart({
    ...fixture.model,
    key: { name: "artifact-scope-check" },
    binary,
    timeoutSeconds: 1,
    engineScope: {
      establishTimeoutMs: 100,
      noteFailure: () => undefined,
      unitSuffix: () => "fixture",
      async resolve() {
        await Promise.resolve();
        replaceFixtureFile(model);
        return { ok: false as const, reason: "not-linux" as const };
      },
    },
  });
  if ("result" in prepared) throw new Error(prepared.result.error);
  const result = await prepared.start(() => undefined);
  expect(result).toMatchObject({ ok: false, pid: null, error: "ManagedArtifactChanged: model" });
  expect(existsSync(marker)).toBe(false);
});

test("managed ModelRun changes its prepared digest for a different file generation at the same path", () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-run-artifact-digest-"));
  using fixture = modelRunEnvironment(dir);
  const opts = { ...fixture.model, key: { name: "artifact-digest-check" } };
  const first = server.prepareManagedServerStart(opts);
  if ("result" in first) throw new Error(first.result.error);
  const model = join(dir, "fixture-models", fixture.model.target);
  replaceFixtureFile(model);
  const next = server.prepareManagedServerStart(opts);
  if ("result" in next) throw new Error(next.result.error);
  expect(next.effectiveSpecDigest).not.toBe(first.effectiveSpecDigest);
  expect(next.launch.artifacts.model.evidence).toBe("filesystem-metadata");
  expect(next.launch.artifacts.model.generationDigest).not.toBe(
    first.launch.artifacts.model.generationDigest,
  );
  expect(next.launch.artifacts.binary).toEqual(first.launch.artifacts.binary);
});

test("managed ModelRun does not commit readiness when an artifact changes after spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "managed-run-artifact-readiness-"));
  using fixture = modelRunEnvironment(dir);
  const binary = join(dir, "llama-server");
  const reserver = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(reserver.port);
  await reserver.stop(true);
  writeManagedFakeEngine(binary, port);
  const model = join(dir, "fixture-models", fixture.model.target);
  const committed = mock(() => undefined);
  const key = { name: "artifact-readiness-check" };
  let pid: number | undefined;
  const plan = server.prepareManagedServerStart({
    ...fixture.model,
    binary,
    key,
    endpoint: { host: "127.0.0.1", port },
    timeoutSeconds: 5,
    onEvent: (event) => {
      if (event.type !== "launch") return;
      pid = event.pid;
      replaceFixtureFile(model);
    },
  });
  if ("result" in plan) throw new Error(plan.result.error);
  try {
    const result = await plan.start(committed);
    expect(result).toMatchObject({ ok: false, pid, error: "ManagedArtifactChanged: model" });
    expect(committed).not.toHaveBeenCalled();
    expect(server.readServerState(key)).toMatchObject({ publicationPending: true, pid });
  } finally {
    if (pid !== undefined && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* Already exited. */
      }
    }
  }
});
