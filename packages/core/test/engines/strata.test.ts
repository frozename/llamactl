/* eslint-disable @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Bun's rejects/resolves matchers are typed as void. */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  EngineAdapter,
  EngineBootEnv,
  ModelHostSpecForEngine,
} from "../../src/engines/types.js";
import type { PidIdentityDeps, SignalIdentity } from "../../src/pidIdentity.js";

import { createStrataEngine, strataEngine } from "../../src/engines/strata.js";
import { existsSync, mkdirSync, writeFileSync } from "../../src/safe-fs.js";

function tempDir(tag: string): string {
  return join(
    tmpdir(),
    `strata-test-${tag}-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function makeBinary(dir: string, name = "strata-server"): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

function makeConfig(dir: string, value: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

function baseSpec(extra: Partial<ModelHostSpecForEngine> = {}): ModelHostSpecForEngine {
  const dir = tempDir("spec");
  const binary = makeBinary(dir);
  const config = makeConfig(dir, { args: ["--native", "x"], model_name: "x.gguf" });
  return {
    engine: "strata",
    binary,
    endpoint: { host: "127.0.0.1", port: 8100 },
    hostedModels: [{ rel: "qwen/qwen-32b.gguf" }],
    extraArgs: ["/opt/strata/serve/server.py", "--engine", "strata", "--config", config],
    timeoutSeconds: 60,
    ...extra,
  };
}

// #220: /v1/models always lists the model; /ready answers 503 until setServeReady(true).
function readinessServer(modelId: string): {
  endpoint: { host: string; port: number };
  readyHits: () => number;
  setServeReady: (value: boolean) => void;
  stop: () => Promise<void>;
} {
  let serveReady = false;
  let hits = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: modelId }] });
      }
      if (path === "/ready") {
        hits += 1;
        return serveReady
          ? Response.json({ status: "ready", model: modelId })
          : new Response("loading", { status: 503 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { port } = server;
  if (port === undefined) throw new Error("probe server did not bind a port");
  return {
    endpoint: { host: "127.0.0.1", port },
    readyHits: (): number => hits,
    setServeReady: (value): void => {
      serveReady = value;
    },
    stop: async (): Promise<void> => {
      await server.stop();
    },
  };
}

describe("strata validateSpec", () => {
  test("accepts a well-formed spec", () => {
    expect(strataEngine.validateSpec(baseSpec())).toEqual({ ok: true });
  });

  test("rejects empty binary", () => {
    const r = strataEngine.validateSpec(baseSpec({ binary: "" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/binary/i);
  });

  test("rejects non-existent binary", () => {
    const r = strataEngine.validateSpec(
      baseSpec({ binary: join(tempDir("missing"), "strata-server") }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });

  test("rejects binary whose basename is not strata-server", () => {
    const dir = tempDir("badname");
    const r = strataEngine.validateSpec(baseSpec({ binary: makeBinary(dir, "python3") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/strata-server/);
  });

  test("rejects non-loopback host", () => {
    const r = strataEngine.validateSpec(baseSpec({ endpoint: { host: "10.1.2.3", port: 8100 } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/loopback/);
  });

  test("rejects non-numeric port", () => {
    const r = strataEngine.validateSpec(
      baseSpec({ endpoint: { host: "127.0.0.1", port: "8100" as unknown as number } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/port/i);
  });

  test("rejects more than one hosted model", () => {
    const r = strataEngine.validateSpec(
      baseSpec({
        hostedModels: [{ rel: "a/a.gguf" }, { rel: "b/b.gguf" }],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hostedModels/);
  });

  test("rejects extraArgs[0] not ending in serve/server.py", () => {
    const spec = baseSpec();
    const r = strataEngine.validateSpec({
      ...spec,
      extraArgs: [
        spec.extraArgs[0]!.replace("serve/server.py", "other.py"),
        ...spec.extraArgs.slice(1),
      ],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/server\.py/);
  });

  test("rejects missing --engine strata", () => {
    const spec = baseSpec();
    const r = strataEngine.validateSpec({
      ...spec,
      extraArgs: spec.extraArgs.filter((a) => a !== "strata").filter((a) => a !== "--engine"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--engine/);
  });

  test("rejects missing --config", () => {
    const spec = baseSpec();
    const idx = spec.extraArgs.indexOf("--config");
    const r = strataEngine.validateSpec({
      ...spec,
      extraArgs: spec.extraArgs.filter((_, i) => i !== idx && i !== idx + 1),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--config/);
  });

  test("rejects non-existent --config file", () => {
    const spec = baseSpec();
    const idx = spec.extraArgs.indexOf("--config");
    const args = [...spec.extraArgs];
    args[idx + 1] = join(tempDir("noconfig"), "missing.json");
    const r = strataEngine.validateSpec({ ...spec, extraArgs: args });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not found/i);
  });

  test("rejects extraArgs that set --host or --port", () => {
    const spec = baseSpec({ extraArgs: [...baseSpec().extraArgs, "--host", "127.0.0.1"] });
    const r = strataEngine.validateSpec(spec);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--host|--port/);
  });
});

describe("strata buildBootCommand", () => {
  test("appends owned --host/--port after extraArgs", () => {
    const spec = baseSpec();
    const built = strataEngine.buildBootCommand(spec, {});
    expect(built.binary).toBe(spec.binary);
    expect(built.args).toEqual([...spec.extraArgs, "--host", "127.0.0.1", "--port", "8100"]);
  });
});

describe("strata prepareLaunch", () => {
  function setup(
    opts: {
      config?: unknown;
      rel?: string;
      createModel?: boolean;
    } = {},
  ): { spec: ModelHostSpecForEngine; env: EngineBootEnv; modelsDir: string } {
    const dir = tempDir("prep");
    const modelsDir = join(dir, "models");
    const rel = opts.rel ?? "qwen/qwen-32b.gguf";
    const nativePath = join(modelsDir, rel);
    if (opts.createModel !== false) {
      mkdirSync(nativePath.split("/").slice(0, -1).join("/"), { recursive: true });
      writeFileSync(nativePath, "G");
    }
    const configValue = opts.config ?? {
      args: ["--native", nativePath],
      model_name: rel.split("/").pop(),
    };
    const config = makeConfig(dir, configValue);
    const spec = baseSpec({
      hostedModels: [{ rel }],
      extraArgs: ["/opt/strata/serve/server.py", "--engine", "strata", "--config", config],
    });
    return { spec, env: { LLAMACTL_MODELS_DIR: modelsDir }, modelsDir };
  }

  test("accepts a coherent run-config", async () => {
    const { spec, env } = setup();
    await expect(strataEngine.prepareLaunch?.(spec, env)).resolves.toBeUndefined();
  });

  test("throws on invalid JSON", async () => {
    const dir = tempDir("badjson");
    const modelsDir = join(dir, "models");
    mkdirSync(modelsDir, { recursive: true });
    const config = join(dir, "run.json");
    writeFileSync(config, "{not json");
    const spec = baseSpec({
      extraArgs: ["/o/serve/server.py", "--engine", "strata", "--config", config],
    });
    await expect(
      strataEngine.prepareLaunch?.(spec, { LLAMACTL_MODELS_DIR: modelsDir }),
    ).rejects.toThrow(/not valid JSON/);
  });

  test("throws when args is not an array", async () => {
    const { spec, env } = setup({ config: { model_name: "qwen-32b.gguf" } });
    await expect(strataEngine.prepareLaunch?.(spec, env)).rejects.toThrow(/no args array/);
  });

  test("throws when --native does not match resolved rel, naming both settings", async () => {
    const { spec, env, modelsDir } = setup({
      config: { args: ["--native", "/totally/wrong/path.gguf"], model_name: "qwen-32b.gguf" },
    });
    const configPath = spec.extraArgs[spec.extraArgs.indexOf("--config") + 1];
    await expect(strataEngine.prepareLaunch?.(spec, env)).rejects.toThrow(
      `strata run-config ${String(configPath)} --native must be ${join(modelsDir, "qwen/qwen-32b.gguf")} (models dir + ModelHost spec.hostedModels[0].rel "qwen/qwen-32b.gguf"); got /totally/wrong/path.gguf. Update the run-config --native and the manifest rel together.`,
    );
  });

  test("reports a missing --native as null", async () => {
    const { spec, env } = setup({ config: { args: [], model_name: "qwen-32b.gguf" } });
    await expect(strataEngine.prepareLaunch?.(spec, env)).rejects.toThrow(
      /hostedModels\[0\]\.rel "qwen\/qwen-32b\.gguf"\); got null\./,
    );
  });

  test("throws when native model file does not exist", async () => {
    const { spec, env } = setup({ createModel: false });
    await expect(strataEngine.prepareLaunch?.(spec, env)).rejects.toThrow(/does not exist/);
  });

  test("throws when rel escapes models dir", async () => {
    const { spec, env } = setup({ rel: "../escape.gguf", createModel: false });
    await expect(strataEngine.prepareLaunch?.(spec, env)).rejects.toThrow(/escapes models dir/);
  });

  test("throws when neither model_name nor aliases advertise the basename", async () => {
    const dir = tempDir("nomatch");
    const modelsDir = join(dir, "models");
    const rel = "qwen/qwen-32b.gguf";
    const nativePath = join(modelsDir, rel);
    mkdirSync(nativePath.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(nativePath, "G");
    const config = makeConfig(dir, {
      args: ["--native", nativePath],
      model_name: "totally-different.gguf",
      aliases: ["other"],
    });
    const spec = baseSpec({
      hostedModels: [{ rel }],
      extraArgs: ["/o/serve/server.py", "--engine", "strata", "--config", config],
    });
    await expect(
      strataEngine.prepareLaunch?.(spec, { LLAMACTL_MODELS_DIR: modelsDir }),
    ).rejects.toThrow(/model_name or aliases/);
  });

  test("throws when run-config host is non-loopback", async () => {
    const dir = tempDir("badhost");
    const modelsDir = join(dir, "models");
    const rel = "qwen/qwen-32b.gguf";
    const nativePath = join(modelsDir, rel);
    mkdirSync(nativePath.split("/").slice(0, -1).join("/"), { recursive: true });
    writeFileSync(nativePath, "G");
    const config = makeConfig(dir, {
      args: ["--native", nativePath],
      model_name: "qwen-32b.gguf",
      host: "10.9.9.9",
    });
    const spec = baseSpec({
      hostedModels: [{ rel }],
      extraArgs: ["/o/serve/server.py", "--engine", "strata", "--config", config],
    });
    await expect(
      strataEngine.prepareLaunch?.(spec, { LLAMACTL_MODELS_DIR: modelsDir }),
    ).rejects.toThrow(/host must be loopback/);
  });

  test("throws when no models dir is configured", async () => {
    const { spec } = setup();
    await expect(strataEngine.prepareLaunch?.(spec, {})).rejects.toThrow(/LLAMACTL_MODELS_DIR/);
  });
});

interface KillCall {
  pid: number;
  signal: NodeJS.Signals;
}

interface TeardownHarness {
  engine: EngineAdapter;
  enginePid: number;
  killCalls: KillCall[];
  state: { shutdownCalls: number };
}

function teardownHarness(opts: {
  childCommands: string[];
  alive: (pid: number) => boolean;
}): TeardownHarness {
  const enginePid = 101;
  let commandCall = 0;
  let clock = 0;
  const killCalls: KillCall[] = [];
  const state = { shutdownCalls: 0 };
  const engine = createStrataEngine({
    listChildren: () => [enginePid],
    processCommand: () =>
      opts.childCommands[Math.min(commandCall++, opts.childCommands.length - 1)] ?? null,
    isAlive: (pid) => opts.alive(pid),
    kill: (pid, signal) => {
      killCalls.push({ pid, signal });
    },
    sleep: () => {
      clock += 1_000;
      return Promise.resolve();
    },
    now: () => clock,
    shutdown: () => {
      state.shutdownCalls += 1;
      return Promise.resolve();
    },
    verify: () => "alive",
  });
  return { engine, enginePid, killCalls, state };
}

describe("strata teardown", () => {
  test("(a) engine exits within the wait window — no SIGKILL", async () => {
    const h = teardownHarness({ childCommands: ["/bin/engine --serve"], alive: () => false });
    await h.engine.teardown(999);
    expect(h.state.shutdownCalls).toBe(1);
    expect(h.killCalls).toEqual([]);
  });

  test("(b) engine survives the wait — exactly one SIGKILL to the engine pid", async () => {
    const h = teardownHarness({ childCommands: ["/bin/engine --serve"], alive: () => true });
    await h.engine.teardown(999);
    expect(h.killCalls).toEqual([{ pid: h.enginePid, signal: "SIGKILL" }]);
  });

  test("(c) a child whose command no longer has a --serve token is never killed", async () => {
    // First processCommand (gather) sees --serve; the re-check before kill does not.
    const h = teardownHarness({
      childCommands: ["/bin/engine --serve", "init"],
      alive: () => true,
    });
    await h.engine.teardown(999);
    expect(h.killCalls).toEqual([]);
  });

  test("(d) unverifiable identity — nothing signalled", async () => {
    const killCalls: KillCall[] = [];
    let shutdownCalls = 0;
    const engine = createStrataEngine({
      listChildren: () => [101],
      processCommand: () => "/bin/engine --serve",
      isAlive: () => true,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      shutdown: () => {
        shutdownCalls += 1;
        return Promise.resolve();
      },
      verify: () => "unknown",
    });
    const identity: SignalIdentity = { recordPath: "/tmp/does-not-exist" };
    await engine.teardown(999, identity);
    expect(shutdownCalls).toBe(0);
    expect(killCalls).toEqual([]);
  });

  test("(e) expectCommand mismatch stops everything even though the record verifies without it", async () => {
    // The record itself verifies alive when no command expectation is folded
    // in; only the merged expectCommand exposes the mismatched command. Teardown
    // must forward expectCommand to verify (as gracefulShutdown does), which
    // flips the verdict to unknown and aborts before any shutdown or kill.
    const seenDeps: PidIdentityDeps[] = [];
    const killCalls: KillCall[] = [];
    let shutdownCalls = 0;
    const engine = createStrataEngine({
      listChildren: () => [101],
      processCommand: () => "/bin/engine --serve",
      isAlive: () => true,
      kill: (pid, signal) => {
        killCalls.push({ pid, signal });
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
      shutdown: () => {
        shutdownCalls += 1;
        return Promise.resolve();
      },
      verify: (_recordPath, _pid, deps) => {
        seenDeps.push(deps ?? {});
        return deps?.expectCommand === undefined ? "alive" : "unknown";
      },
    });
    const identity: SignalIdentity = {
      recordPath: "/tmp/rec",
      expectCommand: { binary: "strata-server" },
    };
    await engine.teardown(999, identity);
    expect(seenDeps[0]?.expectCommand).toEqual({ binary: "strata-server" });
    expect(shutdownCalls).toBe(0);
    expect(killCalls).toEqual([]);
  });

  test("(f) a child whose command has --server-foo but no --serve token is not selected", async () => {
    const h = teardownHarness({ childCommands: ["/bin/engine --server-foo"], alive: () => true });
    await h.engine.teardown(999);
    expect(h.killCalls).toEqual([]);
  });
});

describe("strata probeReady", () => {
  test("probeReady waits for the readiness probe even when /v1/models already lists a model", async () => {
    const probe = readinessServer("qwen-32b.gguf");
    const readiness = { path: "/ready", expectStatus: 200, expectJson: { status: "ready" } };
    try {
      const notReady = await strataEngine.probeReady(probe.endpoint, 400, readiness);
      expect(notReady.ready).toBe(false);
      probe.setServeReady(true);
      const ready = await strataEngine.probeReady(probe.endpoint, 2000, readiness);
      expect(ready.ready).toBe(true);
      expect(ready.modelIds).toContain("qwen-32b.gguf");
      expect(probe.readyHits()).toBeGreaterThan(0);
    } finally {
      await probe.stop();
    }
  });

  test("probeReady without readiness keeps the /v1/models-only behaviour", async () => {
    const probe = readinessServer("qwen-32b.gguf");
    try {
      const result = await strataEngine.probeReady(probe.endpoint, 2000);
      expect(result.ready).toBe(true);
      expect(result.modelIds).toContain("qwen-32b.gguf");
      expect(probe.readyHits()).toBe(0);
    } finally {
      await probe.stop();
    }
  });
});

describe("strata adapter identity", () => {
  test("strataEngine is registered under the strata name", () => {
    expect(strataEngine.name).toBe("strata");
  });

  test("prepareLaunch happy path leaves no stray files behind the binary check", () => {
    const spec = baseSpec();
    expect(existsSync(spec.binary)).toBe(true);
  });
});
