// #284 (DF-11): `llamactl residency plan` — RED tests pinning the CLI
// projection of the read-only residencyPlan query. At the pinned base the
// residency command knows only `status`, so every case fails by assertion:
// runResidency answers "Unknown residency subcommand: plan" and the
// renderResidencyPlan export does not exist. New exports are probed through
// guarded dynamic imports, never static named imports.
import type { NodeClient } from "@llamactl/remote";

import { noderunStore, router, workloadSchema, workloadStore } from "@llamactl/remote";
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as workloadMod from "../src/commands/workload.js";
import { resetGlobals } from "../src/dispatcher.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "../src/safe-fs.js";

const ROUTER_ENV_KEYS = [
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
  "DEV_STORAGE",
  "LLAMACTL_RESIDENCY_STORE",
  "LLAMACTL_NODE_NAME",
] as const;

const SPAWN_TIMEOUT_MS = 10_000;
// Each bin case cold-starts the CLI; the test limit must sit above the 10 s spawnSync limit.
const CLI_SPAWN_TEST_TIMEOUT_MS = 20_000;

type ResidencyDeps = {
  getNodeClientByName: (node: string) => NodeClient;
};

type ResidencyRunner = (args: string[], deps?: ResidencyDeps) => Promise<number>;

type ResidencyPlanRenderer = (
  request: { node: string; to: string; from: string | null },
  plan: unknown,
) => string;

type PlanJson = {
  ok?: boolean;
  victims?: string[];
  replacements?: string[];
  protected?: string[];
  budget?: { memoryGiB?: number; source?: string };
  dryRun?: boolean;
  storeAppliesToNode?: boolean;
  servingNode?: string | null;
  deadlineMs?: number;
  reason?: string;
};

type RunPhase = "Pending" | "Running" | "Failed" | "Stopped";

interface RunManifestOptions {
  node?: string;
  enabled?: boolean;
  profiles?: string;
  phase?: RunPhase;
  expectedMemoryGiB?: number;
  gateway?: boolean;
}

let tmp = "";
let workloadsDir = "";
let storePath = "";
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-residency-plan-cli-"));
  workloadsDir = join(tmp, "workloads");
  storePath = join(tmp, "residency-state", "operations.sqlite");
  savedEnv = {};
  for (const key of ROUTER_ENV_KEYS) savedEnv[key] = process.env[key];
  Object.assign(process.env, {
    LLAMACTL_WORKLOADS_DIR: workloadsDir,
    LLAMACTL_CONFIG: join(tmp, "config-missing"),
    DEV_STORAGE: join(tmp, "dev"),
    LLAMACTL_RESIDENCY_STORE: storePath,
    LLAMACTL_NODE_NAME: "local",
  });
  setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  resetGlobals();
});

afterEach(() => {
  setSystemTime();
  for (const key of ROUTER_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  workloadMod.__resetWorkloadTestSeams();
  resetGlobals();
  rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

async function loadResidency(): Promise<{ run: ResidencyRunner; mod: Record<string, unknown> }> {
  const mod = (await import("../src/commands/residency.js").catch(() => ({}))) as Record<
    string,
    unknown
  >;
  expect(typeof mod["runResidency"]).toBe("function");
  return { run: mod["runResidency"] as ResidencyRunner, mod };
}

function renderResidencyPlanOf(mod: Record<string, unknown>): ResidencyPlanRenderer {
  const fn = mod["renderResidencyPlan"];
  expect(typeof fn).toBe("function");
  return fn as ResidencyPlanRenderer;
}

function stripClock(p: unknown): Record<string, unknown> {
  const { deadlineMs, ...rest } = p as Record<string, unknown>;
  return rest;
}

function runManifest(name: string, options: RunManifestOptions = {}): workloadSchema.ModelRun {
  const annotations =
    options.profiles === undefined
      ? undefined
      : { ["llamactl.io/residency-profiles"]: options.profiles };
  return workloadSchema.ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: {
      name,
      ...(annotations === undefined ? {} : { annotations }),
    },
    spec: {
      node: options.node ?? "local",
      enabled: options.enabled ?? true,
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...(options.expectedMemoryGiB === undefined
        ? {}
        : { resources: { expectedMemoryGiB: options.expectedMemoryGiB } }),
      ...(options.gateway === true ? { gateway: true } : {}),
    },
    ...(options.phase === undefined
      ? {}
      : {
          status: {
            phase: options.phase,
            lastTransitionTime: "2026-01-01T00:00:00.000Z",
          },
        }),
  });
}

function seedRouterFixture(annotateProfiles = true): void {
  workloadStore.saveWorkload(
    runManifest("chat-a", {
      node: "local",
      ...(annotateProfiles ? { profiles: "chat" } : {}),
      phase: "Running",
      expectedMemoryGiB: 10,
    }),
    workloadsDir,
  );
  workloadStore.saveWorkload(
    runManifest("code-b", {
      node: "local",
      ...(annotateProfiles ? { profiles: "code" } : {}),
      phase: "Stopped",
      expectedMemoryGiB: 12,
    }),
    workloadsDir,
  );
  workloadStore.saveWorkload(
    runManifest("embed", { node: "local", phase: "Running", expectedMemoryGiB: 1 }),
    workloadsDir,
  );
  noderunStore.saveNodeRun(
    {
      apiVersion: "llamactl/v1",
      kind: "NodeRun",
      metadata: { name: "local", labels: {} },
      spec: { node: "local", budget: { memoryGiB: 24 }, infra: [] },
    },
    workloadsDir,
  );
}

function snapshotTree(dir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of snapshotTree(path, rel)) out.set(key, value);
    } else if (entry.isFile()) {
      out.set(rel, readFileSync(path).toString("base64"));
    }
  }
  return out;
}

function withCapturedIo<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };

  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  return fn()
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = stdoutOrig;

      process.stderr.write = stderrOrig;
    });
}

function leafHandler(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
  method: string,
): (input: unknown) => Promise<unknown> {
  return async (input: unknown): Promise<unknown> => {
    calls.push(`${proc}.${method}`);
    inputs.push(input);
    const handler = handlers[`${proc}.${method}`];
    if (handler === undefined) {
      throw new Error(`unexpected ${proc}.${method}`);
    }
    return await handler(input);
  };
}

function procedureNamespace(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
  proc: string,
): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return leafHandler(calls, inputs, handlers, proc, prop);
    },
  });
}

function recordingClient(
  calls: string[],
  inputs: unknown[],
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
): NodeClient {
  const target: Record<string, unknown> = {};
  return new Proxy(target, {
    get(_target, prop): unknown {
      if (typeof prop !== "string") return undefined;
      return procedureNamespace(calls, inputs, handlers, prop);
    },
  }) as unknown as NodeClient;
}

interface ResidencyRecording {
  calls: string[];
  inputs: unknown[];
  nodes: string[];
  deps: ResidencyDeps;
}

function setupResidency(
  handlers: Record<string, (input: unknown) => Promise<unknown>>,
): ResidencyRecording {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const nodes: string[] = [];
  const client = recordingClient(calls, inputs, handlers);
  return {
    calls,
    inputs,
    nodes,
    deps: {
      getNodeClientByName: (node: string): NodeClient => {
        nodes.push(node);
        return client;
      },
    },
  };
}

function routerBackedDeps(): ResidencyDeps {
  return {
    getNodeClientByName: () =>
      ({
        residencyPlan: {
          query: (input: { node: string; to: string; from?: string }): Promise<unknown> =>
            router.createCaller({}).residencyPlan(input),
        },
      }) as unknown as NodeClient,
  };
}

const CANNED_PLAN = {
  ok: true,
  noop: false,
  node: "gpu1",
  from: "chat",
  to: "code",
  victims: ["chat-a"],
  replacements: ["code-b"],
  retained: [],
  protected: ["embed"],
  skipped: [],
  beforeGiB: 10,
  afterGiB: 12,
  peakGiB: 12,
  budgetGiB: 24,
  steps: [],
  deadlineMs: 1_800_000_000_000,
  dryRun: true,
  inFlightOperationId: null,
  storeAppliesToNode: true,
  servingNode: "gpu1",
  budget: { memoryGiB: 24, source: "noderun" },
  store: { path: "/tmp/rs/operations.sqlite", present: false, scope: "serving-process" },
};

async function expectPlanRefusal(
  run: ResidencyRunner,
  rec: ResidencyRecording,
  args: string[],
  needle: string,
): Promise<void> {
  const { result: code, stdout, stderr } = await withCapturedIo(() => run(args, rec.deps));
  expect(code).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain(needle);
  expect(rec.calls).toEqual([]);
  expect(rec.nodes).toEqual([]);
}

describe("llamactl residency plan", () => {
  test("plan --json prints the residencyPlan payload through the dispatcher", async () => {
    // Kills: dropping the plan branch, or printing human output under --json.
    seedRouterFixture();
    const { run } = await loadResidency();
    const expectedPlan = await router.createCaller({}).residencyPlan({
      node: "local",
      to: "code",
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code", "--json"], routerBackedDeps()),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const parsed = JSON.parse(stdout) as PlanJson;
    expect(stripClock(parsed)).toEqual(stripClock(expectedPlan));
    expect(parsed.ok).toBe(true);
    expect(parsed.victims).toEqual(["chat-a"]);
    expect(parsed.replacements).toEqual(["code-b"]);
    expect(parsed.protected).toEqual(["embed"]);
    expect(parsed.budget).toEqual({ memoryGiB: 24, source: "noderun" });
    expect(parsed.dryRun).toBe(true);
    expect(parsed.storeAppliesToNode).toBe(true);
    expect(parsed.servingNode).toBe("local");
    expect(typeof parsed.deadlineMs).toBe("number");
  });

  test("plan renders the human-readable residency plan", async () => {
    // Kills: swapping the victims and replacements labels, or dropping the budget source.
    seedRouterFixture();
    const { run, mod } = await loadResidency();
    const expectedPlan = await router.createCaller({}).residencyPlan({
      node: "local",
      to: "code",
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code"], routerBackedDeps()),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const render = renderResidencyPlanOf(mod);
    expect(stdout).toBe(render({ node: "local", to: "code", from: null }, expectedPlan));
    expect(stdout).toContain("Node:         local");
    expect(stdout).toContain("Switch:       (current) -> code");
    expect(stdout).toContain("Mode:         dry-run (no starts, stops, loads or store writes)");
    expect(stdout).toContain("Budget:       24.0 GiB (source: noderun)");
    expect(stdout).toContain("Result:       ok");
    expect(stdout).toContain("Victims:      chat-a");
    expect(stdout).toContain("Replacements: code-b");
    expect(stdout).toContain("Protected:    embed");
    // storeAppliesToNode is true here, so the store-scope Note must not render.
    expect(stdout).not.toContain("Note:");
    expect(stdout).not.toContain("was not observed by this serving process");
  });

  test("plan renders the store-scope Note when storeAppliesToNode is false", async () => {
    // Kills: dropping the storeAppliesToNode === false Note branch, or inverting it.
    const { run } = await loadResidency();
    const rec = setupResidency({
      "residencyPlan.query": (): Promise<unknown> =>
        Promise.resolve({ ...CANNED_PLAN, storeAppliesToNode: false, servingNode: "local" }),
    });

    const {
      result: code,
      stdout,
      stderr,
    } = await withCapturedIo(() => run(["plan", "--node", "gpu1", "--to", "code"], rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("Result:       ok");
    expect(stdout).toContain(
      "Note:         the in-flight store state for gpu1 was not observed by this serving process\n",
    );
    expect(rec.calls).toEqual(["residencyPlan.query"]);
  });

  test("plan renders a NotOptedIn refusal with exit 0 on both surfaces", async () => {
    // Kills: a refusal exiting 1, or the refusal reason not being rendered.
    seedRouterFixture(false);
    const { run } = await loadResidency();

    const human = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code"], routerBackedDeps()),
    );
    expect(human.result).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Result:       refused (NotOptedIn)");
    expect(human.stdout).toContain("Detail:       residency plan refused: NotOptedIn");
    expect(human.stdout).toContain("Workloads:    none");

    const json = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code", "--json"], routerBackedDeps()),
    );
    expect(json.result).toBe(0);
    expect(json.stderr).toBe("");
    const parsed = JSON.parse(json.stdout) as { ok?: boolean; reason?: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("NotOptedIn");
  });

  test("plan is a dry run: workloads tree and residency store untouched", async () => {
    // Kills: the plan path writing manifests or opening the operation store.
    seedRouterFixture();
    const { run } = await loadResidency();
    const before = snapshotTree(workloadsDir);

    const json = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code", "--json"], routerBackedDeps()),
    );
    expect(json.result).toBe(0);
    const human = await withCapturedIo(() =>
      run(["plan", "--node", "local", "--to", "code"], routerBackedDeps()),
    );
    expect(human.result).toBe(0);

    const after = snapshotTree(workloadsDir);
    expect([...after.entries()].sort()).toEqual([...before.entries()].sort());
    expect(existsSync(join(tmp, "residency-state"))).toBe(false);
  });

  test("plan forwards --from and records exactly one residencyPlan.query", async () => {
    // Kills: dropping --from forwarding, or issuing a mutate/subscribe call.
    const { run } = await loadResidency();
    const rec = setupResidency({
      "residencyPlan.query": (): Promise<unknown> => Promise.resolve(CANNED_PLAN),
    });

    const { result: code, stderr } = await withCapturedIo(() =>
      run(["plan", "--node", "gpu1", "--to", "code", "--from", "chat", "--json"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(rec.nodes).toEqual(["gpu1"]);
    expect(rec.calls).toEqual(["residencyPlan.query"]);
    expect(rec.inputs).toStrictEqual([{ node: "gpu1", to: "code", from: "chat" }]);
    for (const call of rec.calls) {
      expect(call.endsWith(".mutate")).toBe(false);
      expect(call.endsWith(".subscribe")).toBe(false);
    }
  });

  test("plan --node=/--to= syntax sends no from key", async () => {
    // Kills: sending from: undefined instead of omitting the key.
    const { run } = await loadResidency();
    const rec = setupResidency({
      "residencyPlan.query": (): Promise<unknown> => Promise.resolve(CANNED_PLAN),
    });

    const { result: code, stderr } = await withCapturedIo(() =>
      run(["plan", "--node=gpu1", "--to=code"], rec.deps),
    );

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(rec.calls).toEqual(["residencyPlan.query"]);
    expect(rec.inputs).toStrictEqual([{ node: "gpu1", to: "code" }]);
    expect(Object.keys(rec.inputs[0] as Record<string, unknown>).sort()).toEqual(["node", "to"]);
    for (const call of rec.calls) {
      expect(call.endsWith(".mutate")).toBe(false);
      expect(call.endsWith(".subscribe")).toBe(false);
    }
  });

  test("residency --help advertises the plan subcommand", async () => {
    // Kills: an unregistered usage or help line for plan.
    const { run } = await loadResidency();
    const rec = setupResidency({});

    const { result: code, stdout, stderr } = await withCapturedIo(() => run(["--help"], rec.deps));

    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("plan --node <name> --to <profile> [--from <profile>] [--json]");
    expect(rec.calls).toEqual([]);
    expect(rec.nodes).toEqual([]);
  });

  describe("plan refusals", () => {
    test("requires --to <profile>", async () => {
      // Kills: treating a missing --to as a client call or exiting 0.
      const { run } = await loadResidency();
      const rec = setupResidency({});
      await expectPlanRefusal(
        run,
        rec,
        ["plan", "--node", "gpu1"],
        "residency plan: --to <profile> is required",
      );
    });

    test("refuses --node all", async () => {
      // Kills: fanning a plan out over every node in the context.
      const { run } = await loadResidency();
      const rec = setupResidency({});
      await expectPlanRefusal(
        run,
        rec,
        ["plan", "--node", "all", "--to", "code"],
        "residency plan: --node all is not supported; name one node",
      );
    });

    test("rejects unknown arguments", async () => {
      // Kills: silently ignoring an unrecognized flag.
      const { run } = await loadResidency();
      const rec = setupResidency({});
      await expectPlanRefusal(
        run,
        rec,
        ["plan", "--node", "gpu1", "--to", "code", "--bogus"],
        "residency plan: unknown argument --bogus",
      );
    });

    test("requires --node when globals are unset", async () => {
      // Kills: defaulting the plan target to the local node implicitly.
      const { run } = await loadResidency();
      const rec = setupResidency({});
      await expectPlanRefusal(
        run,
        rec,
        ["plan", "--to", "code"],
        "residency plan: --node <name> is required",
      );
    });

    test("bare 'plan' is the plan subcommand missing --node, not an unknown subcommand", async () => {
      // Kills: the pre-#284 retarget of 'plan' to the unknown-subcommand error.
      const { run } = await loadResidency();
      const rec = setupResidency({});

      const { result: code, stdout, stderr } = await withCapturedIo(() => run(["plan"], rec.deps));

      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("residency plan: --node <name> is required");
      expect(stderr).not.toContain("Unknown residency subcommand");
      expect(rec.calls).toEqual([]);
      expect(rec.nodes).toEqual([]);
    });

    test("surfaces a rejecting query as exit 1", async () => {
      // Kills: swallowing a transport error into an exit-0 plan.
      const { run } = await loadResidency();
      const rec = setupResidency({
        "residencyPlan.query": (): Promise<unknown> => Promise.reject(new Error("boom")),
      });

      const { result: code, stderr } = await withCapturedIo(() =>
        run(["plan", "--node", "gpu1", "--to", "code"], rec.deps),
      );

      expect(code).toBe(1);
      expect(stderr).toContain("residency plan: boom");
    });
  });
});

describe("bin residency plan routing", () => {
  const BIN = join(import.meta.dir, "../src/bin.ts");

  function runBin(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: tmp,
        DEV_STORAGE: tmp,
        LLAMACTL_RESIDENCY_STORE: join(tmp, "rs.sqlite"),
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test(
    "llamactl --help lists the residency plan command",
    () => {
      // Kills: an unregistered top-level help line for residency plan.
      const r = runBin(["--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("llamactl residency plan --node <name>");
    },
    CLI_SPAWN_TEST_TIMEOUT_MS,
  );
});
