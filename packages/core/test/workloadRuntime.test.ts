import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PidIdentityDeps } from "../src/pidIdentity.js";
import type { ResolvedEnv } from "../src/types.js";
import type {
  ClusterConfigLike,
  ClusterRoute,
  LocalRoute,
  PeerSnapshot,
} from "../src/workloadRuntime.js";

import { writeModelHostState } from "../src/engines/state.js";
import { resolveEnv } from "../src/env.js";
import * as capabilitiesModule from "../src/routing/capabilities.js";
import {
  buildRouteCatalog,
  effectiveCandidate,
  knownRevision,
  workloadOfDeployment,
} from "../src/routing/catalog.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "../src/safe-fs.js";
import * as workloadRuntimeModule from "../src/workloadRuntime.js";
import {
  customCatalogFileFor,
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

// ---------------------------------------------------------------------------
// #518 B-4 — experimental qualification on routes. The catalog join, peer
// snapshot labels, the stageByModel inheritance argument and the new routing
// helpers land with the fix; the widened views below keep these cases
// typechecking before those exports exist (undefined at runtime on the base
// revision, so the typeof guards fail by assertion first).
// ---------------------------------------------------------------------------

type RouteQualificationFields = {
  qualificationStage?: string;
  labels?: Record<string, string>;
};

type QualifiedLocalRoute = LocalRoute & RouteQualificationFields;

type QualifiedPeerSnapshot = Omit<PeerSnapshot, "workloads"> & {
  workloads: (PeerSnapshot["workloads"][number] & {
    labels?: Record<string, string>;
  })[];
};

const routeRecord = (route: ClusterRoute): Record<string, unknown> =>
  route as unknown as Record<string, unknown>;

const isExperimentalRoute = (
  capabilitiesModule as unknown as {
    isExperimentalRoute?: (route: ClusterRoute) => boolean;
  }
).isExperimentalRoute;

const catalogQualificationStages = (
  workloadRuntimeModule as unknown as {
    catalogQualificationStages?: (resolved: ResolvedEnv) => Map<string, string>;
  }
).catalogQualificationStages;

// listClusterRoutes gains a fifth qualification argument with #518; the
// widened signature lets the RED cases pass it before the parameter exists.
type ListClusterRoutesQualified = (
  localRoutes: LocalRoute[],
  peerSnapshots: Map<string, PeerSnapshot>,
  config: ClusterConfigLike,
  now?: number,
  qualification?: { stageByModel?: Map<string, string> },
) => ClusterRoute[];

const listClusterRoutesQualified: ListClusterRoutesQualified =
  workloadRuntimeModule.listClusterRoutes;

const catalogRow = (id: string, rel: string, stage: string): string =>
  `${id}\t${id} label\texp\tcustom\tcustom\t${rel}\torg/${id}\tgguf\t{"qualification":{"stage":"${stage}"}}`;

const writeCustomCatalog = (dir: string, rows: readonly string[]): void => {
  writeFileSync(join(dir, "curated-models.tsv"), `${rows.join("\n")}\n`);
};

const writeRunState = (
  dir: string,
  pid: number,
  state: { rel: string; port: number; extraArgs?: string[] },
): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: state.rel,
      extraArgs: state.extraArgs ?? [],
      host: "127.0.0.1",
      port: state.port,
      pid,
      startedAt: "t",
      tunedProfile: null,
    }),
  );
};

const EXPERIMENTAL_LOCAL: QualifiedLocalRoute = {
  workload: "exp",
  model: "exp/model.gguf",
  host: "127.0.0.1",
  port: 8310,
  engine: "llamacpp",
  kind: "ModelRun",
  pid: 1,
  qualificationStage: "experimental",
};

const PEER_A_CONFIG: ClusterConfigLike = {
  peers: [{ id: "peer-a", endpoint: "https://peer-a.test:443" }],
};

test("listLocalRoutes joins the catalog qualification stage on rel", () => {
  const t = tempEnv();
  try {
    writeCustomCatalog(t.runtimeDir, [
      catalogRow("exp-model", "exp/model.gguf", "experimental"),
      catalogRow("exp-host-model", "exp/host.gguf", "experimental"),
    ]);
    writeRunState(join(t.runtimeDir, "workloads", "exp-run"), process.pid, {
      rel: "exp/model.gguf",
      port: 8301,
      extraArgs: ["--alias", "exp-alias"],
    });
    writeModelHostState(
      {
        kind: "ModelHost",
        engine: "omlx",
        pid: process.pid,
        host: "127.0.0.1",
        port: 8302,
        modelAliases: ["exp/host.gguf", "host.gguf"],
        startedAt: "2026-05-19T00:00:00Z",
      },
      { name: "exp-host" },
      t.resolved,
    );
    writeRunState(join(t.runtimeDir, "workloads", "prod-run"), process.pid, {
      rel: "prod/model.gguf",
      port: 8303,
    });

    const routes = listLocalRoutes(t.resolved);
    const expRoutes = routes.filter((r) => r.workload === "exp-run" || r.workload === "exp-host");
    const prodRoutes = routes.filter((r) => r.workload === "prod-run");
    expect(expRoutes).toHaveLength(4);
    expect(prodRoutes).toHaveLength(1);
    for (const r of expRoutes) {
      expect(routeRecord(r)["qualificationStage"]).toBe("experimental");
    }
    for (const r of prodRoutes) {
      expect("qualificationStage" in r).toBe(false);
    }

    const one = listWorkloadRoutes(t.resolved, "exp-run");
    expect(one).toHaveLength(2);
    for (const r of one) {
      expect(routeRecord(r)["qualificationStage"]).toBe("experimental");
    }
  } finally {
    t.cleanup();
  }
});

test("the join keys on the rel only", () => {
  const t = tempEnv();
  try {
    writeCustomCatalog(t.runtimeDir, [catalogRow("exp-model", "exp/model.gguf", "experimental")]);
    writeRunState(join(t.runtimeDir, "workloads", "alias-run"), process.pid, {
      rel: "unlisted/model.gguf",
      port: 8304,
      extraArgs: ["--alias", "exp/model.gguf"],
    });
    const routes = listLocalRoutes(t.resolved);
    expect(routes).toHaveLength(2);
    for (const r of routes) {
      expect("qualificationStage" in r).toBe(false);
    }
  } finally {
    t.cleanup();
  }
});

test("the last catalog row for a rel wins", () => {
  const t = tempEnv();
  try {
    expect(typeof catalogQualificationStages).toBe("function");
    writeCustomCatalog(t.runtimeDir, [
      catalogRow("dup-a", "dup/model.gguf", "experimental"),
      catalogRow("dup-b", "dup/model.gguf", "validated"),
    ]);
    writeRunState(join(t.runtimeDir, "workloads", "dup-run"), process.pid, {
      rel: "dup/model.gguf",
      port: 8305,
    });
    const routes = listLocalRoutes(t.resolved);
    expect(routes).toHaveLength(1);
    expect(routeRecord(routes[0]!)["qualificationStage"]).toBe("validated");
    expect(catalogQualificationStages?.(t.resolved).get("dup/model.gguf")).toBe("validated");
  } finally {
    t.cleanup();
  }
});

test("listClusterRoutes carries peer snapshot labels", () => {
  expect(typeof isExperimentalRoute).toBe("function");
  const snapshot: QualifiedPeerSnapshot = {
    workloads: [
      {
        modelId: "peer/model.gguf",
        port: 9001,
        labels: { "llamactl.io/qualification": "experimental" },
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const routes = workloadRuntimeModule.listClusterRoutes(
    [],
    new Map<string, PeerSnapshot>([["peer-a", snapshot]]),
    PEER_A_CONFIG,
  );
  const peers = routes.filter((r) => "isPeer" in r);
  expect(peers).toHaveLength(1);
  expect(routeRecord(peers[0]!)["labels"]).toEqual({
    "llamactl.io/qualification": "experimental",
  });
  expect(isExperimentalRoute?.(peers[0]!)).toBe(true);
});

test("an unlabeled peer serving a locally experimental id stays shadowed", () => {
  const snapshot: PeerSnapshot = {
    workloads: [{ modelId: "exp/model.gguf", port: 9100 }],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const snaps = new Map<string, PeerSnapshot>([["peer-a", snapshot]]);
  const routesPlain = workloadRuntimeModule.listClusterRoutes(
    [EXPERIMENTAL_LOCAL],
    snaps,
    PEER_A_CONFIG,
  );
  const routesStaged = listClusterRoutesQualified(
    [EXPERIMENTAL_LOCAL],
    snaps,
    PEER_A_CONFIG,
    Date.now(),
    { stageByModel: new Map([["exp/model.gguf", "experimental"]]) },
  );
  for (const routes of [routesPlain, routesStaged]) {
    const forId = routes.filter((r) => r.model === "exp/model.gguf");
    expect(forId).toHaveLength(1);
    expect("isPeer" in forId[0]!).toBe(false);
  }
});

test("an explicitly non-experimental peer is admitted beside a local experimental route", () => {
  expect(typeof isExperimentalRoute).toBe("function");
  const snapshot: QualifiedPeerSnapshot = {
    workloads: [
      {
        modelId: "exp/model.gguf",
        port: 9100,
        labels: { "llamactl.io/qualification": "validated" },
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const routes = workloadRuntimeModule.listClusterRoutes(
    [EXPERIMENTAL_LOCAL],
    new Map<string, PeerSnapshot>([["peer-a", snapshot]]),
    PEER_A_CONFIG,
  );
  const forId = routes.filter((r) => r.model === "exp/model.gguf");
  expect(forId).toHaveLength(2);
  const peer = forId.find((r) => "isPeer" in r);
  expect(peer).toBeDefined();
  expect(routeRecord(peer!)["labels"]).toEqual({
    "llamactl.io/qualification": "validated",
  });
  expect(isExperimentalRoute?.(peer!)).toBe(false);
});

test("peer-vs-peer: an experimental-only id admits a later non-experimental peer", () => {
  const snapA: QualifiedPeerSnapshot = {
    workloads: [
      {
        modelId: "peer/model.gguf",
        port: 9101,
        labels: { "llamactl.io/qualification": "experimental" },
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const snapB: PeerSnapshot = {
    workloads: [{ modelId: "peer/model.gguf", port: 9102 }],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const snaps = new Map<string, PeerSnapshot>([
    ["peer-a", snapA],
    ["peer-b", snapB],
  ]);
  const peerA = { id: "peer-a", endpoint: "https://peer-a.test:443" };
  const peerB = { id: "peer-b", endpoint: "https://peer-b.test:443" };
  const routes = workloadRuntimeModule.listClusterRoutes([], snaps, {
    peers: [peerA, peerB],
  });
  const forId = routes.filter((r) => r.model === "peer/model.gguf");
  expect(forId).toHaveLength(2);
  const catalog = buildRouteCatalog({ routes });
  expect(effectiveCandidate(catalog, "peer/model.gguf")?.advertisement.ownerNodeId).toBe("peer-b");

  const routesRev = workloadRuntimeModule.listClusterRoutes([], snaps, {
    peers: [peerB, peerA],
  });
  const forIdRev = routesRev.filter((r) => r.model === "peer/model.gguf");
  expect(forIdRev).toHaveLength(1);
  const only = forIdRev[0]!;
  expect("isPeer" in only && only.targetNodeId === "peer-b").toBe(true);
});

test("peer routes take the catalog stage by model id", () => {
  const stageByModel = new Map([["cat/model.gguf", "experimental"]]);
  const unlabeled: PeerSnapshot = {
    workloads: [{ modelId: "cat/model.gguf", port: 9200 }],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const labelled: QualifiedPeerSnapshot = {
    workloads: [
      {
        modelId: "cat/model.gguf",
        port: 9200,
        labels: { "llamactl.io/qualification": "validated" },
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const routesUnlabeled = listClusterRoutesQualified(
    [],
    new Map<string, PeerSnapshot>([["peer-a", unlabeled]]),
    PEER_A_CONFIG,
    Date.now(),
    { stageByModel },
  );
  const un = routesUnlabeled.find((r) => r.model === "cat/model.gguf");
  expect(un).toBeDefined();
  expect(routeRecord(un!)["qualificationStage"]).toBe("experimental");

  const routesLabelled = listClusterRoutesQualified(
    [],
    new Map<string, PeerSnapshot>([["peer-a", labelled]]),
    PEER_A_CONFIG,
    Date.now(),
    { stageByModel },
  );
  const lb = routesLabelled.find((r) => r.model === "cat/model.gguf");
  expect(lb).toBeDefined();
  expect("qualificationStage" in lb!).toBe(false);
});

test("customCatalogFileFor honours a relocated custom catalog", () => {
  const t = tempEnv();
  const catalogDir = mkdtempSync(join(tmpdir(), "workloadrt-catalog-"));
  const relocated = join(catalogDir, "operator-picks.tsv");
  try {
    expect(customCatalogFileFor(t.resolved)).toBe(join(t.runtimeDir, "curated-models.tsv"));
    writeFileSync(relocated, `${catalogRow("exp-model", "exp/model.gguf", "experimental")}\n`);
    writeCustomCatalog(t.runtimeDir, [catalogRow("exp-model", "exp/model.gguf", "validated")]);
    const resolved = resolveEnv({
      DEV_STORAGE: t.runtimeDir,
      LOCAL_AI_RUNTIME_DIR: t.runtimeDir,
      LOCAL_AI_CUSTOM_CATALOG_FILE: relocated,
    });
    expect(customCatalogFileFor(resolved)).toBe(relocated);
    writeRunState(join(t.runtimeDir, "workloads", "exp-run"), process.pid, {
      rel: "exp/model.gguf",
      port: 8306,
    });
    const routes = listLocalRoutes(resolved);
    expect(routes).toHaveLength(1);
    expect(routeRecord(routes[0]!)["qualificationStage"]).toBe("experimental");
  } finally {
    rmSync(catalogDir, { recursive: true, force: true });
    t.cleanup();
  }
});

test("a stable local route after an experimental one clears the experimental-only holder", () => {
  const stableLocal: LocalRoute = {
    workload: "prod",
    model: "exp/model.gguf",
    host: "127.0.0.1",
    port: 8312,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 2,
  };
  const snapshot: QualifiedPeerSnapshot = {
    workloads: [
      {
        modelId: "exp/model.gguf",
        port: 9103,
        labels: { "llamactl.io/qualification": "validated" },
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const routes = workloadRuntimeModule.listClusterRoutes(
    [EXPERIMENTAL_LOCAL, stableLocal],
    new Map<string, PeerSnapshot>([["peer-a", snapshot]]),
    PEER_A_CONFIG,
  );
  const forId = routes.filter((r) => r.model === "exp/model.gguf");
  expect(forId).toHaveLength(2);
  expect(forId.every((r) => !("isPeer" in r))).toBe(true);
  const catalog = buildRouteCatalog({ routes });
  const winner = effectiveCandidate(catalog, "exp/model.gguf");
  expect(winner?.advertisement.deploymentId).toContain("prod");
  expect(winner !== null && "qualification" in winner.advertisement).toBe(false);
});

test("a peer label map carrying a non-string value is dropped entirely", () => {
  const dirtyLabels = { "llamactl.io/qualification": "experimental", count: 7 };
  const snapshot: Omit<QualifiedPeerSnapshot, "workloads"> & {
    workloads: { modelId: string; port: number; labels?: unknown }[];
  } = {
    workloads: [{ modelId: "dirty/model.gguf", port: 9300, labels: dirtyLabels }],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
  const routes = workloadRuntimeModule.listClusterRoutes(
    [],
    new Map<string, PeerSnapshot>([["peer-a", snapshot as unknown as PeerSnapshot]]),
    PEER_A_CONFIG,
  );
  expect(routes).toHaveLength(1);
  expect("labels" in routes[0]!).toBe(false);
  expect(isExperimentalRoute?.(routes[0]!)).toBe(false);
});

test("a local route's labels survive listClusterRoutes unchanged", () => {
  const labelled: QualifiedLocalRoute = {
    workload: "exp",
    model: "exp/model.gguf",
    host: "127.0.0.1",
    port: 8310,
    engine: "llamacpp",
    kind: "ModelRun",
    pid: 1,
    labels: { "llamactl.io/qualification": "validated", team: "eval" },
  };
  const routes = workloadRuntimeModule.listClusterRoutes(
    [labelled],
    new Map<string, PeerSnapshot>(),
    { peers: [] },
  );
  const found = routes.find((r) => r.workload === "exp" && r.model === "exp/model.gguf");
  expect(found).toBeDefined();
  expect(routeRecord(found!)["labels"]).toEqual({
    "llamactl.io/qualification": "validated",
    team: "eval",
  });
});

// ---------------------------------------------------------------------------
// #220 — declared serving readiness in the route source. listLocalRoutes must
// carry the sidecar's readiness onto each route, and listServingLocalRoutes
// partitions routes into ready vs warming by probing that declaration. Both
// exports land with the fix; the namespace lookups keep these cases
// typechecking before they exist (undefined at runtime on the base revision,
// so the typeof guards fail by assertion first).
// ---------------------------------------------------------------------------

type ListServingLocalRoutesFn = (
  resolved: ResolvedEnv,
  opts?: { fetch?: typeof fetch; timeoutMs?: number },
) => Promise<{ ready: LocalRoute[]; warming: LocalRoute[] }>;

const requireListServingLocalRoutes = (): ListServingLocalRoutesFn => {
  const fn = (workloadRuntimeModule as unknown as Record<string, unknown>)[
    "listServingLocalRoutes"
  ] as ListServingLocalRoutesFn;
  expect(typeof fn).toBe("function");
  return fn;
};

type ServingFetchStub = (input: Request | URL | string, init?: RequestInit) => Promise<Response>;

const makeServingStub = (): {
  stub: ServingFetchStub;
  calls: string[];
  setRoutes: (routes: Record<string, (url: string) => Response | Promise<Response>>) => void;
} => {
  const calls: string[] = [];
  let routes: Record<string, (url: string) => Response | Promise<Response>> = {};

  const stub: ServingFetchStub = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const urlObj = new URL(url);
    const lookupKey = urlObj.pathname + urlObj.search;
    const handler = routes[lookupKey];
    if (handler) return Promise.resolve(handler(url));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  return {
    stub,
    calls,
    setRoutes(next: Record<string, (url: string) => Response | Promise<Response>>): void {
      routes = next;
    },
  };
};

const installFetchTripwire = (): { calls: string[]; restore: () => void } => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  const tripwire: ServingFetchStub = (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return Promise.reject(new Error("globalThis.fetch must not be used"));
  };
  globalThis.fetch = tripwire as unknown as typeof fetch;
  return {
    calls,
    restore: (): void => {
      globalThis.fetch = originalFetch;
    },
  };
};

const writeGufoHost = (resolved: ResolvedEnv): void => {
  const state = {
    kind: "ModelHost" as const,
    engine: "llamacpp" as const,
    pid: process.pid,
    host: "127.0.0.1",
    port: 18091,
    modelAliases: ["qwen3-8b", "Qwen3-8B"],
    startedAt: "2026-05-19T00:00:00Z",
    readiness: { path: "/ready", expectJson: { status: "ready" } },
  };
  writeModelHostState(state, { name: "gufo-host" }, resolved);
};

const writeProbeLessHost = (resolved: ResolvedEnv): void => {
  writeModelHostState(
    {
      kind: "ModelHost",
      engine: "omlx",
      pid: process.pid,
      host: "127.0.0.1",
      port: 18094,
      modelAliases: ["omlx-model-a", "omlx-model-b"],
      startedAt: "2026-05-19T00:00:00Z",
    },
    { name: "omlx-host" },
    resolved,
  );
};

const GUFO_ROUTES_STUB = {
  "/v1/models": (): Response => Response.json({ object: "list", data: [{ id: "qwen3-8b" }] }),
};

test("listLocalRoutes carries the declared ModelHost readiness on every alias route", () => {
  const t = tempEnv();
  try {
    writeGufoHost(t.resolved);
    const routes = listLocalRoutes(t.resolved);
    const gufo = routes.filter((r) => r.workload === "gufo-host");
    expect(gufo).toHaveLength(2);
    for (const route of gufo) {
      expect(routeRecord(route)["readiness"]).toEqual({
        path: "/ready",
        expectJson: { status: "ready" },
      });
    }
  } finally {
    t.cleanup();
  }
});

test("listServingLocalRoutes parks readiness-gated routes in warming while the probe reports loading", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    const { stub, setRoutes } = makeServingStub();
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": () => Response.json({ status: "loading" }, { status: 503 }),
    });
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toHaveLength(0);
    expect(result.warming).toHaveLength(2);
    expect(new Set(result.warming.map((r) => r.model))).toEqual(new Set(["qwen3-8b", "Qwen3-8B"]));
    expect(result.warming.every((r) => r.workload === "gufo-host" && r.kind === "ModelHost")).toBe(
      true,
    );
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes marks readiness-gated routes ready when the probe passes", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    const { stub, setRoutes } = makeServingStub();
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": () => Response.json({ status: "ready", model: "gufo" }),
    });
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toHaveLength(2);
    expect(new Set(result.ready.map((r) => r.model))).toEqual(new Set(["qwen3-8b", "Qwen3-8B"]));
    expect(result.warming).toHaveLength(0);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes re-partitions the same routes as readiness flips", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    const { stub, setRoutes } = makeServingStub();
    let readyStatus = 503;
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": (): Response =>
        readyStatus === 503
          ? Response.json({ status: "loading" }, { status: 503 })
          : Response.json({ status: "ready" }),
    });
    const listServing = requireListServingLocalRoutes();
    const opts = { fetch: stub as unknown as typeof fetch, timeoutMs: 2000 };
    const first = await listServing(t.resolved, opts);
    expect(first.ready).toHaveLength(0);
    expect(first.warming).toHaveLength(2);
    readyStatus = 200;
    const second = await listServing(t.resolved, opts);
    expect(second.ready).toHaveLength(2);
    expect(second.warming).toHaveLength(0);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes probes each readiness-declaring workload once per call", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    const { stub, calls, setRoutes } = makeServingStub();
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": () => Response.json({ status: "ready" }),
    });
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toHaveLength(2);
    expect(calls.filter((c) => c.endsWith("/ready"))).toHaveLength(1);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes makes zero fetch calls and reports ready when no route declares readiness", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeProbeLessHost(t.resolved);
    writeRunState(join(t.runtimeDir, "workloads", "plain-run"), process.pid, {
      rel: "org/plain.gguf",
      port: 8411,
    });
    const { stub, calls } = makeServingStub();
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toEqual(listLocalRoutes(t.resolved));
    expect(result.warming).toEqual([]);
    expect(calls).toEqual([]);
    for (const route of result.ready) {
      expect(Object.hasOwn(route, "readiness")).toBe(false);
    }
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes partitions probe-less hosts into ready and warming hosts into warming", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    writeProbeLessHost(t.resolved);
    const { stub, setRoutes } = makeServingStub();
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": () => Response.json({ status: "loading" }, { status: 503 }),
    });
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toHaveLength(2);
    expect(result.ready.every((r) => r.workload === "omlx-host")).toBe(true);
    expect(result.warming).toHaveLength(2);
    expect(result.warming.every((r) => r.workload === "gufo-host")).toBe(true);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

test("listServingLocalRoutes fails closed to warming when the readiness fetch rejects", async () => {
  const t = tempEnv();
  const tripwire = installFetchTripwire();
  try {
    writeGufoHost(t.resolved);
    const { stub, setRoutes } = makeServingStub();
    setRoutes({
      ...GUFO_ROUTES_STUB,
      "/ready": (): Promise<Response> => Promise.reject(new TypeError("socket hangup")),
    });
    const listServing = requireListServingLocalRoutes();
    const result = await listServing(t.resolved, {
      fetch: stub as unknown as typeof fetch,
      timeoutMs: 2000,
    });
    expect(result.ready).toHaveLength(0);
    expect(result.warming).toHaveLength(2);
    expect(result.warming.every((r) => r.workload === "gufo-host")).toBe(true);
    expect(tripwire.calls).toEqual([]);
  } finally {
    tripwire.restore();
    t.cleanup();
  }
});

const MALFORMED_READINESS: [string, unknown][] = [
  ["a non-string path", { path: 5 }],
  ["a path without a leading slash", { path: "ready" }],
  ["a nested expectJson value", { path: "/ready", expectJson: { nested: { a: 1 } } }],
  ["a string expectStatus", { path: "/ready", expectStatus: "200" }],
  ["a non-integer expectStatus", { path: "/ready", expectStatus: 200.5 }],
];

for (const [label, readiness] of MALFORMED_READINESS) {
  test(`listServingLocalRoutes drops malformed declared readiness (${label})`, async () => {
    const t = tempEnv();
    const tripwire = installFetchTripwire();
    try {
      const dir = join(t.runtimeDir, "workloads", "bad-host");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "modelhost.pid"), `${String(process.pid)}\n`);
      writeFileSync(
        join(dir, "modelhost.state"),
        JSON.stringify({
          kind: "ModelHost",
          engine: "llamacpp",
          pid: process.pid,
          host: "127.0.0.1",
          port: 18097,
          modelAliases: ["bad-model"],
          startedAt: "2026-05-19T00:00:00Z",
          readiness,
        }),
      );
      const routes = listLocalRoutes(t.resolved);
      expect(routes).toHaveLength(1);
      const route = routes[0]!;
      expect(route).toEqual({
        workload: "bad-host",
        model: "bad-model",
        host: "127.0.0.1",
        port: 18097,
        engine: "llamacpp",
        kind: "ModelHost",
        pid: process.pid,
      });
      expect(Object.hasOwn(route, "readiness")).toBe(false);

      const { stub, calls } = makeServingStub();
      const listServing = requireListServingLocalRoutes();
      const result = await listServing(t.resolved, {
        fetch: stub as unknown as typeof fetch,
        timeoutMs: 2000,
      });
      expect(result.ready).toEqual(routes);
      expect(result.warming).toEqual([]);
      expect(calls.filter((c) => c.endsWith("/ready"))).toEqual([]);
      expect(tripwire.calls).toEqual([]);
    } finally {
      tripwire.restore();
      t.cleanup();
    }
  });
}
