/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/await-thenable, @typescript-eslint/no-confusing-void-expression -- Healer probe-targets tests use synchronous fetch fakes, no real network, and Bun's resolves matcher is typed as void. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { probeFleet, type ProbeReport, type ProbeResult, stateTransitions } from "../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let runtimeDir = "";

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-probe-targets-"));
});
afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function writeFiles(
  kube: Record<string, unknown>,
  providers: Record<string, unknown>,
): { kubeconfigPath: string; siriusProvidersPath: string } {
  const kubeconfigPath = join(runtimeDir, "kubeconfig.yaml");
  writeFileSync(kubeconfigPath, stringifyYaml(kube));
  const siriusProvidersPath = join(runtimeDir, "sirius-providers.yaml");
  writeFileSync(siriusProvidersPath, stringifyYaml(providers));
  return { kubeconfigPath, siriusProvidersPath };
}

function makeFetchFake(statusByUrl: Map<string, number>): {
  fakeFetch: typeof globalThis.fetch;
  recordedUrls: string[];
} {
  const recordedUrls: string[] = [];
  const fakeFetch = async (url: string | URL): Promise<Response> => {
    const u = String(url);
    recordedUrls.push(u);
    const status = statusByUrl.get(u) ?? 200;
    return new Response("", { status });
  };
  return { fakeFetch: fakeFetch as unknown as typeof globalThis.fetch, recordedUrls };
}

describe("probeFleet — currentContext picks the cluster", () => {
  test("probes the node from the currentContext's cluster, not the first cluster", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "b",
        contexts: [
          { name: "a", cluster: "clusterA" },
          { name: "b", cluster: "clusterB" },
        ],
        clusters: [
          {
            name: "clusterA",
            nodes: [
              {
                name: "nodeA",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "x", baseUrl: "http://a/v1" },
              },
            ],
          },
          {
            name: "clusterB",
            nodes: [
              {
                name: "nodeB",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "y", baseUrl: "http://b/v1" },
              },
            ],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch, recordedUrls } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(1);
    const gw = report.probes.find((p: ProbeResult) => p.name === "nodeB")!;
    expect(gw.name).toBe("nodeB");
    expect(gw.baseUrl).toBe("http://b/v1");
    expect(recordedUrls).toEqual(["http://b/v1"]);
  });
});

describe("probeFleet — kind:'cloud' is a gateway", () => {
  test("a node with kind:'cloud' and a cloud block is probed as gateway", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              {
                name: "c",
                kind: "cloud",
                cloud: { provider: "openai", baseUrl: "http://c/v1" },
                provider: { gateway: "g", providerName: "p" },
              },
            ],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(1);
    const gw = report.probes.find((p: ProbeResult) => p.name === "c")!;
    expect(gw.kind).toBe("gateway");
    expect(gw.name).toBe("c");
    expect(gw.baseUrl).toBe("http://c/v1");
  });

  test("a node with kind:'cloud' but NO cloud block is skipped", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [{ name: "c", kind: "cloud" }],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch, recordedUrls } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toEqual([]);
    expect(recordedUrls).toEqual([]);
  });
});

describe("probeFleet — legacy node with no kind but cloud block", () => {
  test("counts as a gateway", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [{ name: "l", endpoint: "", cloud: { provider: "x", baseUrl: "http://l/v1" } }],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(1);
    const gw = report.probes.find((p: ProbeResult) => p.name === "l")!;
    expect(gw.kind).toBe("gateway");
    expect(gw.name).toBe("l");
    expect(gw.baseUrl).toBe("http://l/v1");
  });
});

describe("probeFleet — explicit non-gateway kind wins over cloud block", () => {
  test("nodes with kind:'agent' or provider field are skipped even with cloud.baseUrl", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              { name: "a", kind: "agent", cloud: { provider: "x", baseUrl: "http://a/v1" } },
              {
                name: "b",
                cloud: { provider: "y", baseUrl: "http://b/v1" },
                provider: { gateway: "g", providerName: "p" },
              },
            ],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch, recordedUrls } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toEqual([]);
    expect(recordedUrls).toEqual([]);
  });
});

describe("probeFleet — empty or missing baseUrl is dropped", () => {
  test("5a: gateways with empty baseUrl are skipped", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              {
                name: "g-empty",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "x", baseUrl: "" },
              },
              {
                name: "g-valid",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "y", baseUrl: "http://g/v1" },
              },
            ],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch, recordedUrls } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(1);
    const gw = report.probes.find((p: ProbeResult) => p.name === "g-valid")!;
    expect(gw.name).toBe("g-valid");
    expect(gw.baseUrl).toBe("http://g/v1");
    expect(recordedUrls).toEqual(["http://g/v1"]);
  });

  test("5b: providers with empty or missing baseUrl are skipped", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [{ name: "home", nodes: [] }],
      },
      {
        providers: [
          { name: "p-empty", kind: "openai", baseUrl: "" },
          { name: "p-missing", kind: "openai" },
          { name: "p-valid", kind: "openai", baseUrl: "http://p/v1" },
        ],
      },
    );
    const { fakeFetch, recordedUrls } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes).toHaveLength(1);
    const prov = report.probes.find((p: ProbeResult) => p.name === "p-valid")!;
    expect(prov.name).toBe("p-valid");
    expect(prov.baseUrl).toBe("http://p/v1");
    expect(recordedUrls).toEqual(["http://p/v1"]);
  });
});

describe("probeFleet — malformed YAML is treated as absent", () => {
  test("invalid kubeconfig YAML yields no probes without throwing", async () => {
    const kubeconfigPath = join(runtimeDir, "kubeconfig.yaml");
    writeFileSync(kubeconfigPath, "a: [unclosed");
    const siriusProvidersPath = join(runtimeDir, "sirius-providers.yaml");
    writeFileSync(
      siriusProvidersPath,
      stringifyYaml({ providers: [{ name: "p1", kind: "openai", baseUrl: "http://p/v1" }] }),
    );
    const { fakeFetch } = makeFetchFake(new Map());
    await expect(
      probeFleet({
        kubeconfigPath,
        siriusProvidersPath,
        fetch: fakeFetch,
        now: () => 1_700_000_000_000,
      }),
    ).resolves.toMatchObject({ unhealthy: 0, probes: [{ kind: "provider" }] });
  });
});

describe("probeFleet — gateways come before providers", () => {
  test("probe order is gateway first, then providers in file order", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              {
                name: "gw",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "x", baseUrl: "http://gw/v1" },
              },
            ],
          },
        ],
      },
      {
        providers: [
          { name: "p1", kind: "openai", baseUrl: "http://p1/v1" },
          { name: "p2", kind: "anthropic", baseUrl: "http://p2/v1" },
        ],
      },
    );
    const { fakeFetch } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    expect(report.probes.map((p: ProbeResult) => p.kind)).toEqual([
      "gateway",
      "provider",
      "provider",
    ]);
    expect(report.probes.map((p: ProbeResult) => p.name)).toEqual(["gw", "p1", "p2"]);
  });
});

describe("probeFleet — non-ok status below 500 is unhealthy", () => {
  test("exact unhealthy count matches probes with status < 500 and >= 400", async () => {
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              {
                name: "gw",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "x", baseUrl: "http://gw/v1" },
              },
            ],
          },
        ],
      },
      {
        providers: [
          { name: "p1", kind: "openai", baseUrl: "http://p1/v1" },
          { name: "p2", kind: "anthropic", baseUrl: "http://p2/v1" },
        ],
      },
    );
    const statusByUrl = new Map<string, number>();
    statusByUrl.set("http://gw/v1", 404);
    statusByUrl.set("http://p1/v1", 503);
    statusByUrl.set("http://p2/v1", 200);
    const { fakeFetch } = makeFetchFake(statusByUrl);
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now: () => 1_700_000_000_000,
    });
    const states = report.probes.map((p: ProbeResult) => p.state);
    const statuses = report.probes.map((p: ProbeResult) => p.status);
    expect(states).toEqual(["unhealthy", "unhealthy", "healthy"]);
    expect(statuses).toEqual([404, 503, 200]);
    expect(report.unhealthy).toBe(2);
  });
});

describe("probeFleet — injected clock drives latencyMs and ts", () => {
  test("now() values drive startedAt, post-fetch latency, and report ts", async () => {
    let tick = 0;
    const now = (): number => {
      tick++;
      switch (tick) {
        case 1:
          return 1000; // startedAt
        case 2:
          return 1250; // after fetch
        default:
          return 2000; // report ts (every later call)
      }
    };
    const { kubeconfigPath, siriusProvidersPath } = writeFiles(
      {
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "home" }],
        clusters: [
          {
            name: "home",
            nodes: [
              {
                name: "gw",
                endpoint: "",
                kind: "gateway",
                cloud: { provider: "x", baseUrl: "http://gw/v1" },
              },
            ],
          },
        ],
      },
      { providers: [] },
    );
    const { fakeFetch } = makeFetchFake(new Map());
    const report = await probeFleet({
      kubeconfigPath,
      siriusProvidersPath,
      fetch: fakeFetch,
      now,
    });
    const gw = report.probes.find((p: ProbeResult) => p.name === "gw")!;
    expect(gw.latencyMs).toBe(250);
    expect(report.ts).toBe(new Date(2000).toISOString());
  });
});

describe("stateTransitions — keys on kind as well as name", () => {
  test("a probe that changes kind is treated as a new probe with from:'unknown'", () => {
    const ts = new Date().toISOString();
    const prev: ProbeReport = {
      ts,
      unhealthy: 0,
      probes: [
        {
          name: "x",
          kind: "gateway" as const,
          baseUrl: "http://x/v1",
          state: "healthy" as const,
          status: 200,
          latencyMs: 1,
        },
      ],
    };
    const next: ProbeReport = {
      ts,
      unhealthy: 0,
      probes: [
        {
          name: "x",
          kind: "provider" as const,
          baseUrl: "http://x/v1",
          state: "healthy" as const,
          status: 200,
          latencyMs: 1,
        },
        {
          name: "x",
          kind: "gateway" as const,
          baseUrl: "http://x/v1",
          state: "healthy" as const,
          status: 200,
          latencyMs: 1,
        },
      ],
    };
    const trans = stateTransitions(prev, next);
    expect(trans).toEqual([{ name: "x", kind: "provider", from: "unknown", to: "healthy" }]);
  });
});
