import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import type { InstallResult } from "../src/infra/install.js";
import type { InstalledInfra } from "../src/infra/layout.js";
import type { NodeRunInfraClient } from "../src/workload/noderun-apply.js";

import { mkdtempSync, readFileSync, rmSync } from "../src/safe-fs.js";
import { NodeRpcSkippedError, NodeRpcTimeoutError } from "../src/workload/node-rpc-deadline.js";
import { reconcileNodeRunsOnce } from "../src/workload/noderun-reconciler.js";
import { type NodeRun, NodeRunSchema } from "../src/workload/noderun-schema.js";
import { saveNodeRun } from "../src/workload/noderun-store.js";

let dir = "";

function sampleManifest(name: string, node: string, pkg = "llama-cpp"): NodeRun {
  return NodeRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "NodeRun",
    metadata: { name },
    spec: {
      node,
      infra: [{ pkg, version: "b4500" }],
    },
  });
}

function mockClient(live: InstalledInfra[] = []): NodeRunInfraClient {
  let after = live;
  let queried = false;
  return {
    infraList: {
      async query(): Promise<InstalledInfra[]> {
        await Promise.resolve();
        // After the first query (pre-apply), flip to post-apply state
        // simulating installs.
        if (!queried) {
          queried = true;
          return live;
        }
        return after;
      },
    },
    infraInstall: {
      async mutate(input): Promise<{
        ok: true;
        state: "installed" | "already-present";
        versionDir: string;
        activated: boolean;
      }> {
        await Promise.resolve();
        const result: InstallResult = {
          ok: true,
          state: "installed",
          versionDir: `/fake/${input.pkg}/${input.version}`,
          activated: true,
        };
        after = [...after, { pkg: input.pkg, versions: [input.version], active: input.version }];
        return result;
      },
    },
    infraActivate: {
      async mutate(): Promise<{ ok: true }> {
        await Promise.resolve();
        return { ok: true as const };
      },
    },
    infraUninstall: {
      async mutate(): Promise<{ ok: true; mode: "package"; removed: true }> {
        await Promise.resolve();
        return { ok: true as const, mode: "package" as const, removed: true };
      },
    },
  };
}

/** A client whose infraList.query never settles, like a suspended node; counts the calls. */
function silentClient(calls: { infraList: number }): NodeRunInfraClient {
  return {
    ...mockClient(),
    infraList: {
      query(): Promise<InstalledInfra[]> {
        calls.infraList++;
        return new Promise<InstalledInfra[]>(() => undefined);
      },
    },
  };
}

/** A client whose infraList.query rejects at once with `err`; no deadline has to fire. */
function rejectingClient(err: Error): NodeRunInfraClient {
  return {
    ...mockClient(),
    infraList: {
      query: (): Promise<InstalledInfra[]> => Promise.reject(err),
    },
  };
}

/**
 * #221: a query that never answers on its own. The deadline wrapper hands
 * every query an AbortSignal as its second argument; when the pass deadline
 * fires it aborts that signal, which lands `${tag}:deadline` in the log and
 * rejects the call — the observable proof a node's deadline elapsed.
 */
function hangingInfraQuery(log: string[], tag: string) {
  return (_input?: unknown, o?: { signal?: AbortSignal }): Promise<never> => {
    log.push(`${tag}:query`);
    const signal = o?.signal;
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        log.push(`${tag}:deadline`);
        reject(signal.reason as Error);
      });
    });
  };
}

/** #221: counts infraList queries in flight across every client sharing `counter`. */
function inFlightInfraQuery(counter: {
  current: number;
  max: number;
}): NodeRunInfraClient["infraList"] {
  return {
    query: async (): Promise<InstalledInfra[]> => {
      counter.current += 1;
      counter.max = Math.max(counter.max, counter.current);
      await new Promise((resolve) => setTimeout(resolve, 30));
      counter.current -= 1;
      return [];
    },
  };
}

/** Wait for `cond` across timer turns, at most `turns` turns of 5 ms; never a fixed sleep. */
async function waitUntil(cond: () => boolean, turns = 400): Promise<void> {
  let left = turns;
  while (left > 0 && !cond()) {
    left--;
    await new Promise<void>((resolve): void => {
      setTimeout(resolve, 5);
    });
  }
}

/** Procedure references typed as plain values, so the identity checks never touch a method. */
interface InfraProcedureRefs {
  infraActivate: { mutate: unknown };
  infraInstall: { mutate: unknown };
  infraList: { query: unknown };
  infraUninstall: { mutate: unknown };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llamactl-noderun-reconciler-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reconcileNodeRunsOnce", () => {
  test("empty dir → empty reports + errors: 0", async () => {
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
    });
    expect(result.reports).toEqual([]);
    expect(result.errors).toBe(0);
  });

  test("reconciles every NodeRun manifest and persists new status", async () => {
    saveNodeRun(sampleManifest("local-fleet", "local"), dir);
    saveNodeRun(sampleManifest("gpu1-fleet", "gpu1"), dir);
    const calls: string[] = [];
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => {
        calls.push(node);
        return mockClient();
      },
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
    });
    expect(result.reports).toHaveLength(2);
    expect(result.errors).toBe(0);
    expect(calls.sort()).toEqual(["gpu1", "local"]);
    // Status persisted back to disk.
    const local = parseYaml(readFileSync(join(dir, "local-fleet.yaml"), "utf8")) as NodeRun;
    expect(local.status?.phase).toBe("Converged");
  });

  test("filter narrows to a subset", async () => {
    saveNodeRun(sampleManifest("a", "nodeA"), dir);
    saveNodeRun(sampleManifest("b", "nodeB"), dir);
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      filter: (m) => m.metadata.name === "a",
    });
    expect(result.reports.map((r) => r.name)).toEqual(["a"]);
  });

  test("onReport fires per manifest, in order within a node", async () => {
    saveNodeRun(sampleManifest("a", "nodeA"), dir);
    saveNodeRun(sampleManifest("b", "nodeA"), dir);
    const names: string[] = [];
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => mockClient(),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      onReport: (r) => names.push(r.manifestName),
    });
    // listNodeRuns returns alphabetical order; a node's manifests stay serial.
    expect(names).toEqual(["a", "b"]);
    expect(result.reports.map((r) => r.name)).toEqual(["a", "b"]);
  });

  test("client throws → surfaces as phase:Failed + errors:1 without tearing down the loop", async () => {
    saveNodeRun(sampleManifest("a", "down-node"), dir);
    saveNodeRun(sampleManifest("b", "good-node"), dir);
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => {
        if (node === "down-node") {
          throw new Error("node unreachable");
        }
        return mockClient();
      },
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
    });
    expect(result.errors).toBe(1);
    expect(result.reports).toHaveLength(2);
    const failed = result.reports.find((r) => r.name === "a")!;
    expect(failed.phase).toBe("Failed");
    expect(failed.error).toMatch(/node unreachable/);
    const ok = result.reports.find((r) => r.name === "b")!;
    expect(ok.phase).toBe("Converged");
  });
});

describe("reconcileNodeRunsOnce node RPC deadline", () => {
  test("a silent node fails its first NodeRun after one query deadline and skips the rest of the pass", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    saveNodeRun(sampleManifest("b-run", "z13"), dir);
    const calls = { infraList: 0 };
    const silent = silentClient(calls);
    const state = { settled: false };
    const run = reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => silent,
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 5 },
    }).finally((): void => {
      state.settled = true;
    });
    await waitUntil((): boolean => state.settled);
    expect(state.settled).toBe(true);
    const result = await run;
    expect(result.errors).toBe(2);
    expect(result.reports.map((r) => r.name)).toEqual(["a-run", "b-run"]);
    const first = result.reports.find((r) => r.name === "a-run")!;
    const second = result.reports.find((r) => r.name === "b-run")!;
    expect(first.phase).toBe("Failed");
    expect(first.error).toMatch(/did not respond to infraList\.query within 5 ms/);
    expect(second.phase).toBe("Failed");
    expect(second.error).toMatch(/skipped infraList\.query for this pass/);
    expect(calls.infraList).toBe(1);
  });

  test("a silent node does not hold up NodeRuns on another node", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    saveNodeRun(sampleManifest("b-run", "mac-mini"), dir);
    const silent = silentClient({ infraList: 0 });
    const state = { settled: false };
    const run = reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => (node === "z13" ? silent : mockClient()),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 5 },
    }).finally((): void => {
      state.settled = true;
    });
    await waitUntil((): boolean => state.settled);
    expect(state.settled).toBe(true);
    const result = await run;
    expect(result.errors).toBe(1);
    const down = result.reports.find((r) => r.name === "a-run")!;
    const up = result.reports.find((r) => r.name === "b-run")!;
    expect(down.phase).toBe("Failed");
    expect(down.error).toMatch(/did not respond to infraList\.query within 5 ms/);
    expect(up.phase).toBe("Converged");
  });

  test("the client handed to the artifact resolver bounds queries and leaves mutations unwrapped", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    const raw = mockClient();
    const seen: NodeRunInfraClient[] = [];
    await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => raw,
      getArtifactResolver: (_node, client) => {
        seen.push(client);
        return (): Promise<{ tarballUrl: string; sha256: string }> =>
          Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) });
      },
    });
    expect(seen).toHaveLength(1);
    const rawRefs: InfraProcedureRefs = raw;
    const handedRefs: InfraProcedureRefs = seen[0]!;
    expect(handedRefs.infraList.query).not.toBe(rawRefs.infraList.query);
    expect(handedRefs.infraInstall.mutate).toBe(rawRefs.infraInstall.mutate);
    expect(handedRefs.infraActivate.mutate).toBe(rawRefs.infraActivate.mutate);
    expect(handedRefs.infraUninstall.mutate).toBe(rawRefs.infraUninstall.mutate);
  });

  test("a NodeRun whose node query timed out reports reason NodeUnreachable", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    const timeout = new NodeRpcTimeoutError("z13", "infraList.query", 5);
    const seen: string[] = [];
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => rejectingClient(timeout),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 60_000 },
      onReport: (r) => {
        seen.push(r.reason ?? "none");
      },
    });
    expect(result.errors).toBe(1);
    expect(result.reports).toEqual([
      {
        name: "a-run",
        node: "z13",
        phase: "Failed",
        actions: 0,
        errors: 1,
        error: timeout.message,
        reason: "NodeUnreachable",
      },
    ]);
    expect(seen).toEqual(["NodeUnreachable"]);
  });

  test("a NodeRun skipped after an earlier timeout reports reason NodeUnreachable", async () => {
    saveNodeRun(sampleManifest("b-run", "z13"), dir);
    const earlier = new NodeRpcTimeoutError("z13", "infraList.query", 5);
    const skipped = new NodeRpcSkippedError("z13", "infraList.query", earlier);
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => rejectingClient(skipped),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 60_000 },
    });
    expect(result.errors).toBe(1);
    expect(result.reports).toEqual([
      {
        name: "b-run",
        node: "z13",
        phase: "Failed",
        actions: 0,
        errors: 1,
        error: skipped.message,
        reason: "NodeUnreachable",
      },
    ]);
  });

  test("an error the node answers with carries no NodeUnreachable reason", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    const seen: string[] = [];
    const result = await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => rejectingClient(new Error("boom")),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 60_000 },
      onReport: (r) => {
        seen.push(r.reason ?? "none");
      },
    });
    expect(result.errors).toBe(1);
    expect(result.reports).toEqual([
      { name: "a-run", node: "z13", phase: "Failed", actions: 0, errors: 1, error: "boom" },
    ]);
    expect(result.reports.filter((r) => "reason" in r)).toEqual([]);
    expect(seen).toEqual(["none"]);
  });

  test("a per-node query deadline bounds a silent node when the pass default is long", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    saveNodeRun(sampleManifest("b-run", "mac-mini"), dir);
    const silent = silentClient({ infraList: 0 });
    const state = { settled: false };
    const run = reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: (node) => (node === "z13" ? silent : mockClient()),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 60_000 },
      rpcTimeoutsFor: (node: string) => (node === "z13" ? { queryMs: 5 } : undefined),
    }).finally((): void => {
      state.settled = true;
    });
    await waitUntil((): boolean => state.settled);
    expect(state.settled).toBe(true);
    const result = await run;
    const down = result.reports.find((r) => r.name === "a-run")!;
    const up = result.reports.find((r) => r.name === "b-run")!;
    expect(down.phase).toBe("Failed");
    expect(down.error).toMatch(/did not respond to infraList\.query within 5 ms/);
    expect(down.reason).toBe("NodeUnreachable");
    expect(up.phase).toBe("Converged");
  });

  test("a node mutateMs does not bound NodeRun mutations", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    const raw = mockClient();
    const seen: NodeRunInfraClient[] = [];
    await reconcileNodeRunsOnce({
      workloadsDir: dir,
      getClient: () => raw,
      getArtifactResolver: (_node, client) => {
        seen.push(client);
        return (): Promise<{ tarballUrl: string; sha256: string }> =>
          Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) });
      },
      rpcTimeoutsFor: () => ({ queryMs: 5, mutateMs: 1 }),
    });
    expect(seen).toHaveLength(1);
    const rawRefs: InfraProcedureRefs = raw;
    const handedRefs: InfraProcedureRefs = seen[0]!;
    expect(handedRefs.infraList.query).not.toBe(rawRefs.infraList.query);
    expect(handedRefs.infraInstall.mutate).toBe(rawRefs.infraInstall.mutate);
    expect(handedRefs.infraActivate.mutate).toBe(rawRefs.infraActivate.mutate);
    expect(handedRefs.infraUninstall.mutate).toBe(rawRefs.infraUninstall.mutate);
  });
});

describe("reconcileNodeRunsOnce concurrent nodes (#221)", () => {
  test("a silent node does not delay a healthy node's NodeRun", async () => {
    saveNodeRun(sampleManifest("a-run", "z13"), dir);
    saveNodeRun(sampleManifest("b-run", "mac-mini"), dir);
    const log: string[] = [];
    const silentZ13: NodeRunInfraClient = {
      ...mockClient(),
      infraList: { query: hangingInfraQuery(log, "z13") },
    };
    const baseMac = mockClient();
    let macQueries = 0;
    const macClient: NodeRunInfraClient = {
      ...baseMac,
      infraList: {
        query: () => {
          macQueries += 1;
          if (macQueries === 1) log.push("mac-mini:query");
          return baseMac.infraList.query();
        },
      },
    };
    const opts = {
      workloadsDir: dir,
      getClient: (node: string): NodeRunInfraClient => (node === "z13" ? silentZ13 : macClient),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      rpcTimeouts: { queryMs: 60_000 },
      rpcTimeoutsFor: (node: string): { queryMs?: number } | undefined =>
        node === "z13" ? { queryMs: 300 } : node === "mac-mini" ? { queryMs: 20 } : undefined,
      resolveNodeIdentity: (node: string): string | null => node,
    };
    const result = await reconcileNodeRunsOnce(opts);

    expect(log).toHaveLength(3);
    expect(log.indexOf("mac-mini:query")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("mac-mini:query")).toBeLessThan(log.indexOf("z13:deadline"));
    expect(log[log.length - 1]).toBe("z13:deadline");
    expect(result.reports.map((r) => r.name)).toEqual(["a-run", "b-run"]);
    const down = result.reports.find((r) => r.name === "a-run")!;
    expect(down.phase).toBe("Failed");
    expect(down.reason).toBe("NodeUnreachable");
    const up = result.reports.find((r) => r.name === "b-run")!;
    expect(up.phase).toBe("Converged");
    expect(result.errors).toBe(1);
  });

  test("bounds in-flight NodeRun reconciles to nodeConcurrency", async () => {
    const counter = { current: 0, max: 0 };
    for (const node of ["n1", "n2", "n3"]) {
      saveNodeRun(sampleManifest(`run-${node}`, node), dir);
    }
    const opts = {
      workloadsDir: dir,
      getClient: (): NodeRunInfraClient => ({
        ...mockClient(),
        infraList: inFlightInfraQuery(counter),
      }),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      resolveNodeIdentity: (node: string): string | null => node,
      nodeConcurrency: 2,
    };
    const result = await reconcileNodeRunsOnce(opts);

    expect(counter.max).toBe(2);
    expect(result.reports.map((r) => r.name)).toEqual(["run-n1", "run-n2", "run-n3"]);
  });

  test("nodes that resolve to one identity stay serial under nodeConcurrency", async () => {
    const counter = { current: 0, max: 0 };
    saveNodeRun(sampleManifest("run-local", "local"), dir);
    saveNodeRun(sampleManifest("run-mini", "mac-mini"), dir);
    const opts = {
      workloadsDir: dir,
      getClient: (): NodeRunInfraClient => ({
        ...mockClient(),
        infraList: inFlightInfraQuery(counter),
      }),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      resolveNodeIdentity: (node: string): string | null =>
        node === "local" || node === "mac-mini" ? "same-host" : node,
      nodeConcurrency: 4,
    };
    await reconcileNodeRunsOnce(opts);

    expect(counter.max).toBe(1);
  });

  test("without resolveNodeIdentity the pass stays serial", async () => {
    const counter = { current: 0, max: 0 };
    for (const node of ["n1", "n2", "n3"]) {
      saveNodeRun(sampleManifest(`run-${node}`, node), dir);
    }
    const opts = {
      workloadsDir: dir,
      getClient: (): NodeRunInfraClient => ({
        ...mockClient(),
        infraList: inFlightInfraQuery(counter),
      }),
      getArtifactResolver: () => (): Promise<{ tarballUrl: string; sha256: string }> =>
        Promise.resolve({ tarballUrl: "https://x", sha256: "a".repeat(64) }),
      nodeConcurrency: 4,
    };
    await reconcileNodeRunsOnce(opts);

    expect(counter.max).toBe(1);
  });
});
