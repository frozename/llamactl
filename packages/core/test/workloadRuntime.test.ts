import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PidIdentityDeps } from "../src/pidIdentity.js";
import type { ResolvedEnv } from "../src/types.js";

import { writeModelHostState } from "../src/engines/state.js";
import { buildRouteCatalog, knownRevision, workloadOfDeployment } from "../src/routing/catalog.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";
import {
  ensureWorkloadRuntimeDir,
  listLocalRoutes,
  listLocalWorkloads,
  listWorkloadDirs,
  listWorkloadRoutes,
  migrateLegacySingletonRuntime,
  workloadRuntimeDir,
} from "../src/workloadRuntime.js";

const tempEnv = (): { runtimeDir: string; resolved: ResolvedEnv; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "workloadrt-"));
  return {
    runtimeDir: dir,
    resolved: { LOCAL_AI_RUNTIME_DIR: dir } as ResolvedEnv,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("workloadRuntimeDir composes the expected path", () => {
  const t = tempEnv();
  try {
    expect(workloadRuntimeDir(t.resolved, { name: "gemma" })).toBe(
      join(t.runtimeDir, "workloads", "gemma"),
    );
  } finally {
    t.cleanup();
  }
});

test("ensureWorkloadRuntimeDir creates the directory", () => {
  const t = tempEnv();
  try {
    const d = ensureWorkloadRuntimeDir(t.resolved, { name: "gemma" });
    expect(existsSync(d)).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("listLocalWorkloads returns names of workload subdirs with pidfiles", () => {
  const t = tempEnv();
  try {
    const a = join(t.runtimeDir, "workloads", "a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "llama-server.pid"), "99999\n");
    mkdirSync(join(t.runtimeDir, "workloads", "b"), { recursive: true });
    const entries = listLocalWorkloads(t.resolved);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["a"]);
    expect(entries[0]!.pid).toBe(99999);
    expect(entries[0]!.alive).toBe(false);
  } finally {
    t.cleanup();
  }
});

test("listLocalWorkloads discovers ModelHost pid files alongside llama-server pid", () => {
  const t = tempEnv();
  try {
    const a = join(t.runtimeDir, "workloads", "a");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "modelhost.pid"), "777\n");
    const entries = listLocalWorkloads(t.resolved);
    expect(entries.map((e) => e.name)).toEqual(["a"]);
    expect(entries[0]!.pid).toBe(777);
  } finally {
    t.cleanup();
  }
});

test("listLocalRoutes returns ModelRun entries from llama-server state", () => {
  const t = tempEnv();
  try {
    const dir = join(t.runtimeDir, "workloads", "test-run");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
    writeFileSync(
      join(dir, "llama-server.state"),
      JSON.stringify({
        rel: "org/model.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: 8090,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        tunedProfile: null,
      }),
    );
    const routes = listLocalRoutes(t.resolved);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      workload: "test-run",
      model: "org/model.gguf",
      host: "127.0.0.1",
      port: 8090,
      engine: "llamacpp",
      kind: "ModelRun",
    });
  } finally {
    t.cleanup();
  }
});

test("listLocalRoutes returns one route per ModelHost alias", () => {
  const t = tempEnv();
  try {
    const dir = join(t.runtimeDir, "workloads", "mlx-host");
    mkdirSync(dir, { recursive: true });
    const state = {
      kind: "ModelHost" as const,
      engine: "omlx" as const,
      pid: process.pid,
      host: "127.0.0.1",
      port: 8094,
      modelAliases: ["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"],
      startedAt: "2026-05-19T00:00:00Z",
    };
    writeModelHostState(state, { name: "mlx-host" }, t.resolved);
    const routes = listLocalRoutes(t.resolved);
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((r) => r.model))).toEqual(
      new Set(["mlx-community/Qwen3-8B-MLX-4bit", "Qwen3-8B-MLX-4bit"]),
    );
    expect(routes.every((r) => r.engine === "omlx" && r.kind === "ModelHost")).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("listLocalRoutes skips dead processes", () => {
  const t = tempEnv();
  try {
    const dir = join(t.runtimeDir, "workloads", "dead");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "modelhost.pid"), "99999999\n");
    writeFileSync(
      join(dir, "modelhost.state"),
      JSON.stringify({
        kind: "ModelHost",
        engine: "omlx",
        pid: 99999999,
        host: "127.0.0.1",
        port: 8094,
        modelAliases: ["x"],
        startedAt: "t",
      }),
    );
    expect(listLocalRoutes(t.resolved)).toHaveLength(0);
  } finally {
    t.cleanup();
  }
});

test("listWorkloadDirs returns workload subdirs without requiring pidfiles", () => {
  const t = tempEnv();
  try {
    mkdirSync(join(t.runtimeDir, "workloads", "a"), { recursive: true });
    mkdirSync(join(t.runtimeDir, "workloads", "b"), { recursive: true });
    writeFileSync(join(t.runtimeDir, "workloads", "b", "llama-server.pid"), "123\n");
    expect(listWorkloadDirs(t.resolved).sort()).toEqual(["a", "b"]);
  } finally {
    t.cleanup();
  }
});

test("listWorkloadDirs sorts names regardless of creation order", () => {
  const t = tempEnv();
  try {
    for (const name of ["delta", "bravo", "echo", "alpha", "charlie"]) {
      mkdirSync(join(t.runtimeDir, "workloads", name), { recursive: true });
    }
    expect(listWorkloadDirs(t.resolved)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
  } finally {
    t.cleanup();
  }
});

test("migrateLegacySingletonRuntime moves files under a matching workload dir", () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, "llama-server.pid"), "999999\n");
    writeFileSync(
      join(t.runtimeDir, "llama-server.state"),
      JSON.stringify({
        rel: "granite/granite-4.1-8b-Q4_K_M.gguf",
        extraArgs: ["--ctx-size", "4096"],
        host: "127.0.0.1",
        port: "8181",
        binary: "/x/llama-server",
        pid: 999999,
        startedAt: "t",
        tunedProfile: null,
      }),
    );
    writeFileSync(join(t.runtimeDir, "llama-server.log"), "old log");

    const out = migrateLegacySingletonRuntime(t.resolved, [
      {
        metadata: { name: "granite-8b" },
        spec: {
          node: "local",
          target: { kind: "rel", value: "granite/granite-4.1-8b-Q4_K_M.gguf" },
          endpoint: { port: 8181 },
        },
      },
    ]);

    expect(out.kind).toBe("migrated");
    if (out.kind === "migrated") expect(out.workload).toBe("granite-8b");

    const dest = join(t.runtimeDir, "workloads", "granite-8b");
    expect(existsSync(join(dest, "llama-server.pid"))).toBe(true);
    expect(existsSync(join(dest, "llama-server.state"))).toBe(true);
    expect(existsSync(join(dest, "llama-server.log"))).toBe(true);
    const migratedState = JSON.parse(readFileSync(join(dest, "llama-server.state"), "utf8")) as {
      rel?: unknown;
    };
    expect(migratedState.rel).toBe("granite/granite-4.1-8b-Q4_K_M.gguf");
    expect(existsSync(join(t.runtimeDir, "llama-server.pid"))).toBe(false);
    expect(existsSync(join(t.runtimeDir, ".migrated-v2"))).toBe(true);
  } finally {
    t.cleanup();
  }
});

test("migrateLegacySingletonRuntime synthesizes an imperative workload when no manifest matches", () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, "llama-server.pid"), "999999\n");
    writeFileSync(
      join(t.runtimeDir, "llama-server.state"),
      JSON.stringify({
        rel: "orphan/orphan.gguf",
        extraArgs: [],
        host: "127.0.0.1",
        port: "9999",
        binary: "/x/llama-server",
        pid: 999999,
        startedAt: "t",
        tunedProfile: null,
      }),
    );
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe("synthesized");
    if (out.kind === "synthesized") expect(out.workload).toMatch(/^imperative-\d+$/);
  } finally {
    t.cleanup();
  }
});

test("migrateLegacySingletonRuntime is a no-op on second invocation", () => {
  const t = tempEnv();
  try {
    writeFileSync(join(t.runtimeDir, ".migrated-v2"), "");
    writeFileSync(join(t.runtimeDir, "llama-server.pid"), "1\n");
    const out = migrateLegacySingletonRuntime(t.resolved, []);
    expect(out.kind).toBe("skipped");
  } finally {
    t.cleanup();
  }
});

const writeRunWorkload = (dir: string, pid: number, rel: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel,
      extraArgs: [],
      host: "127.0.0.1",
      port: 8090,
      pid,
      startedAt: "t",
      tunedProfile: null,
    }),
  );
};

/** Every recorded pid is alive; each start-time lookup records the pids it was asked for. */
const recordingIdentity = (batches: number[][]): PidIdentityDeps => ({
  probe: (): void => undefined,
  processStartMsMany: (pids): Map<number, number> => {
    batches.push([...pids]);
    return new Map(pids.map((pid) => [pid, 0]));
  },
});

test("listWorkloadRoutes lists one workload's routes and verifies its pid alone", () => {
  const t = tempEnv();
  try {
    writeRunWorkload(join(t.runtimeDir, "workloads", "a"), 4001, "org/a.gguf");
    writeRunWorkload(join(t.runtimeDir, "workloads", "b"), 4002, "org/b.gguf");
    writeModelHostState(
      {
        kind: "ModelHost" as const,
        engine: "omlx" as const,
        pid: 4003,
        host: "127.0.0.1",
        port: 8094,
        modelAliases: ["c-one", "c-two"],
        startedAt: "2026-05-19T00:00:00Z",
      },
      { name: "c" },
      t.resolved,
    );
    const batches: number[][] = [];
    const routes = listWorkloadRoutes(t.resolved, "b", recordingIdentity(batches));
    expect(batches).toEqual([[4002]]);
    const allBatches: number[][] = [];
    const all = listLocalRoutes(t.resolved, recordingIdentity(allBatches));
    expect(allBatches.map((pids) => [...pids].sort((x, y) => x - y))).toEqual([[4001, 4002, 4003]]);
    expect(routes).toHaveLength(1);
    expect(routes).toEqual(all.filter((r) => r.workload === "b"));
    const hostBatches: number[][] = [];
    const hostRoutes = listWorkloadRoutes(t.resolved, "c", recordingIdentity(hostBatches));
    expect(hostBatches).toEqual([[4003]]);
    expect(hostRoutes).toHaveLength(2);
    expect(hostRoutes).toEqual(all.filter((r) => r.workload === "c"));
  } finally {
    t.cleanup();
  }
});

test("listWorkloadRoutes lists nothing for a name that is not a workload directory", () => {
  const t = tempEnv();
  try {
    writeRunWorkload(join(t.runtimeDir, "workloads", "a"), 4001, "org/a.gguf");
    writeFileSync(join(t.runtimeDir, "workloads", "file"), "");
    symlinkSync(join(t.runtimeDir, "workloads", "a"), join(t.runtimeDir, "workloads", "link"));
    // A legacy singleton's records sit in the runtime root, one level above
    // the workloads: a name escaping upward must not reach them.
    writeRunWorkload(t.runtimeDir, 4009, "org/legacy.gguf");
    // Stray records in the workloads root itself, which no name may reach either.
    writeRunWorkload(join(t.runtimeDir, "workloads"), 4008, "org/stray.gguf");
    const listed = listLocalRoutes(t.resolved, recordingIdentity([]));
    expect(listed.map((r) => r.workload)).toEqual(["a"]);
    for (const name of ["", ".", "..", "a/.", "a\0", "missing", "file", "link"]) {
      expect(listWorkloadRoutes(t.resolved, name, recordingIdentity([]))).toEqual([]);
    }
  } finally {
    t.cleanup();
  }
});

test("one workload's routes give its deployment the epoch the full catalog gives it", () => {
  const t = tempEnv();
  try {
    writeRunWorkload(join(t.runtimeDir, "workloads", "a"), 4001, "org/a.gguf");
    writeRunWorkload(join(t.runtimeDir, "workloads", "b"), 4002, "org/b.gguf");
    const deps = recordingIdentity([]);
    const full = buildRouteCatalog({
      routes: listLocalRoutes(t.resolved, deps),
      nodeId: "node-1",
      now: 1,
    });
    const fromFull = full.deployments.filter((d) => d.deploymentId === "deploy/node-1/b");
    expect(fromFull.map((d) => d.deploymentEpoch)).toEqual([knownRevision("pid:4002")]);
    const workload = workloadOfDeployment("deploy/node-1/b", "node-1");
    expect(workload).toBe("b");
    const one = buildRouteCatalog({
      routes: listWorkloadRoutes(t.resolved, workload ?? "", deps),
      nodeId: "node-1",
      now: 1,
    });
    expect(one.deployments).toEqual(fromFull);
    expect(workloadOfDeployment("deploy/node-2/b", "node-1")).toBeNull();
    expect(workloadOfDeployment("route/node-1/b", "node-1")).toBeNull();
  } finally {
    t.cleanup();
  }
});
