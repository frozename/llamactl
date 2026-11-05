// Issue #410 P5a-3c RED — pins the fleet view's pure scope module:
// the 30s nodeTest cadence, per-query reachability tone+label (an
// offline node is err, never an idle "checking" spinner), the
// consoleNodeRows projection (kind fallback, default/tab flags, the
// dispatchable gate and fleet deep links), the exposed-workloads
// filter and the tab-node card's secret-safe env/facts rows. The
// module does not exist at the base commit, so every case fails by
// assertion — never by import error.

import { describe, expect, test } from "bun:test";

import { consoleHref } from "../../src/console/router";

const SCOPE_SPEC = "../../src/console/fleet-scope.ts";

interface NodeReachabilityResult {
  tone: string;
  label: string;
}

interface ConsoleNodeRow {
  name: string;
  kind: string;
  endpoint: string | null;
  endpointHref: string | null;
  isDefault: boolean;
  isTabNode: boolean;
  dispatchable: boolean;
  newTabHref: string | null;
}

interface ExposedWorkload {
  name: string;
  node: string;
  endpoint: string;
}

interface CardEntry {
  key: string;
  value: string;
}

interface TabNodeCardResult {
  env: CardEntry[];
  facts: CardEntry[];
}

interface FleetScopeModule {
  NODE_TEST_INTERVAL_MS?: number;
  nodeReachability?: (query: unknown) => NodeReachabilityResult;
  consoleNodeRows?: (nodeList: unknown, tabNode: string) => ConsoleNodeRow[];
  exposedWorkloads?: (rows: unknown) => ExposedWorkload[];
  tabNodeCard?: (env: unknown, facts: unknown) => TabNodeCardResult;
}

const mod = (await import(SCOPE_SPEC).catch(() => ({}))) as FleetScopeModule;

const NODE_LIST = {
  defaultNode: "local",
  nodes: [
    { name: "local", endpoint: "inproc://local" },
    { name: "agent-1", endpoint: "https://10.0.0.5:7843", effectiveKind: "agent" },
    { name: "gw", endpoint: "http://gw:8080", effectiveKind: "gateway" },
    { name: "rag1", endpoint: "http://rag:9000", effectiveKind: "rag" },
  ],
};

const FACTS = {
  nodeName: "local-mbp",
  hostname: "local-mbp",
  platform: "darwin-arm64",
  os: "darwin",
  arch: "arm64",
  memBytes: 34359738368,
  gpu: { kind: "metal", name: "M4 Pro" },
  versions: { llamactl: "0.0.0", bun: "1.4.3", llamaCppSrcRev: null },
  llamaCppBuildId: null,
  profile: "macbook-pro-48g",
  startedAt: "2026-11-05T00:00:00.000Z",
  advertisedEndpoint: "http://127.0.0.1:8080",
};

function byName(rows: ConsoleNodeRow[]): Map<string, ConsoleNodeRow> {
  return new Map(rows.map((row) => [row.name, row]));
}

describe("fleet scope (#410 P5a-3c)", () => {
  test("NODE_TEST_INTERVAL_MS is 30 seconds", () => {
    expect(typeof mod.NODE_TEST_INTERVAL_MS).toBe("number");
    expect(mod.NODE_TEST_INTERVAL_MS).toBe(30_000);
  });

  test("nodeReachability maps a transport error to err", () => {
    expect(typeof mod.nodeReachability).toBe("function");
    const result = mod.nodeReachability!({ isError: true });
    expect(result.tone).toBe("err");
    expect(typeof result.label).toBe("string");
  });

  test("nodeReachability maps ok:true to ok/reachable", () => {
    expect(typeof mod.nodeReachability).toBe("function");
    const result = mod.nodeReachability!({ data: { ok: true, facts: {} } });
    expect(result.tone).toBe("ok");
    expect(result.label).toBe("reachable");
  });

  test("nodeReachability maps ok:false to err with the error in the label", () => {
    expect(typeof mod.nodeReachability).toBe("function");
    const result = mod.nodeReachability!({ data: { ok: false, error: "ECONNREFUSED" } });
    expect(result.tone).toBe("err");
    expect(result.label).toContain("ECONNREFUSED");
    // Offline is terminal, never the idle "checking" spinner.
    expect(result.tone).not.toBe("idle");
  });

  test("nodeReachability maps a pending query to idle/checking", () => {
    expect(typeof mod.nodeReachability).toBe("function");
    const result = mod.nodeReachability!({});
    expect(result.tone).toBe("idle");
    expect(result.label).toBe("checking");
  });

  test("consoleNodeRows projects every node in order with kind, flags and links", () => {
    expect(typeof mod.consoleNodeRows).toBe("function");
    const rows = mod.consoleNodeRows!(NODE_LIST, "local");
    expect(rows.map((row) => row.name)).toEqual(["local", "agent-1", "gw", "rag1"]);
    const nodes = byName(rows);

    // The inproc local entry has no effectiveKind and falls back to agent.
    expect(nodes.get("local")?.kind).toBe("agent");
    expect(nodes.get("agent-1")?.kind).toBe("agent");
    expect(nodes.get("gw")?.kind).toBe("gateway");
    expect(nodes.get("rag1")?.kind).toBe("rag");

    expect(nodes.get("local")?.endpoint).toBe("inproc://local");
    expect(nodes.get("agent-1")?.endpoint).toBe("https://10.0.0.5:7843");
    expect(nodes.get("local")?.endpointHref).toBeNull();
    expect(nodes.get("agent-1")?.endpointHref).toBe("https://10.0.0.5:7843");
    expect(nodes.get("gw")?.endpointHref).toBe("http://gw:8080");
    expect(nodes.get("rag1")?.endpointHref).toBe("http://rag:9000");

    expect(rows.map((row) => row.isDefault)).toEqual([true, false, false, false]);
    expect(rows.map((row) => row.isTabNode)).toEqual([true, false, false, false]);
    expect(rows.map((row) => row.dispatchable)).toEqual([true, true, false, false]);

    expect(nodes.get("agent-1")?.newTabHref).toBe(consoleHref({ view: "fleet", node: "agent-1" }));
    expect(nodes.get("local")?.newTabHref).toBeNull();
    expect(nodes.get("gw")?.newTabHref).toBeNull();
    expect(nodes.get("rag1")?.newTabHref).toBeNull();
  });

  test("consoleNodeRows gives every dispatchable non-tab node a fleet deep link", () => {
    expect(typeof mod.consoleNodeRows).toBe("function");
    const rows = mod.consoleNodeRows!(NODE_LIST, "agent-1");
    const nodes = byName(rows);
    expect(rows.map((row) => row.isTabNode)).toEqual([false, true, false, false]);
    expect(nodes.get("local")?.newTabHref).toBe(consoleHref({ view: "fleet", node: "local" }));
    expect(nodes.get("agent-1")?.newTabHref).toBeNull();
    expect(nodes.get("gw")?.newTabHref).toBeNull();
    expect(nodes.get("rag1")?.newTabHref).toBeNull();
  });

  test("consoleNodeRows returns no rows for a missing node list", () => {
    expect(typeof mod.consoleNodeRows).toBe("function");
    expect(mod.consoleNodeRows!(null, "local")).toEqual([]);
    expect(mod.consoleNodeRows!(undefined, "local")).toEqual([]);
  });

  test("exposedWorkloads keeps only Running rows with an http(s) endpoint, sorted by name", () => {
    expect(typeof mod.exposedWorkloads).toBe("function");
    const rows = [
      {
        name: "zulu",
        kind: "ModelRun",
        node: "local",
        phase: "Running",
        endpoint: "http://127.0.0.1:9000",
        workerNodes: [],
      },
      {
        name: "alpha",
        kind: "ModelRun",
        node: "agent-1",
        phase: "Running",
        endpoint: "https://10.0.0.5:7843",
        workerNodes: [],
      },
      {
        name: "no-endpoint",
        kind: "ModelRun",
        node: "local",
        phase: "Running",
        endpoint: null,
        workerNodes: [],
      },
      {
        name: "pending",
        kind: "ModelRun",
        node: "local",
        phase: "Pending",
        endpoint: "http://127.0.0.1:9999",
        workerNodes: [],
      },
      {
        name: "stopped",
        kind: "ModelRun",
        node: "local",
        phase: "Stopped",
        endpoint: "http://127.0.0.1:9998",
        workerNodes: [],
      },
      {
        name: "ftp",
        kind: "ModelRun",
        node: "local",
        phase: "Running",
        endpoint: "ftp://files:21",
        workerNodes: [],
      },
      {
        name: "inproc",
        kind: "ModelRun",
        node: "local",
        phase: "Running",
        endpoint: "inproc://local",
        workerNodes: [],
      },
    ];
    expect(mod.exposedWorkloads!(rows)).toEqual([
      { name: "alpha", node: "agent-1", endpoint: "https://10.0.0.5:7843" },
      { name: "zulu", node: "local", endpoint: "http://127.0.0.1:9000" },
    ]);
  });

  test("tabNodeCard sorts env by key and renders secrets as set, never the value", () => {
    expect(typeof mod.tabNodeCard).toBe("function");
    const card = mod.tabNodeCard!(
      {
        LM_API_TOKEN: "[redacted]",
        LLAMA_CPP_PORT: "8080",
        OPENAI_API_KEY: "sk-live-x",
        db_password: "hunter2",
      },
      FACTS,
    );
    expect(card.env).toEqual([
      { key: "LLAMA_CPP_PORT", value: "8080" },
      { key: "LM_API_TOKEN", value: "set" },
      { key: "OPENAI_API_KEY", value: "set" },
      { key: "db_password", value: "set" },
    ]);
    const serialized = JSON.stringify(card);
    expect(serialized).not.toContain("sk-live-x");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("[redacted]");
  });

  test("tabNodeCard treats a redacted value as set even on a non-secret key", () => {
    expect(typeof mod.tabNodeCard).toBe("function");
    const card = mod.tabNodeCard!({ PLAIN_NOTE: "[redacted]", OTHER: "visible" }, undefined);
    expect(card.env).toEqual([
      { key: "OTHER", value: "visible" },
      { key: "PLAIN_NOTE", value: "set" },
    ]);
  });

  test("tabNodeCard exposes the nodeName, platform, llamactl version and advertised endpoint", () => {
    expect(typeof mod.tabNodeCard).toBe("function");
    const card = mod.tabNodeCard!({}, FACTS);
    const facts = new Map(card.facts.map((row) => [row.key, row.value]));
    expect(facts.get("nodeName")).toBe("local-mbp");
    expect(facts.get("platform")).toBe("darwin-arm64");
    expect(facts.get("versions.llamactl")).toBe("0.0.0");
    expect(facts.get("advertisedEndpoint")).toBe("http://127.0.0.1:8080");
  });

  test("tabNodeCard yields empty lists for missing env or facts", () => {
    expect(typeof mod.tabNodeCard).toBe("function");
    const empty = mod.tabNodeCard!(undefined, undefined);
    expect(empty.env).toEqual([]);
    expect(empty.facts).toEqual([]);
    expect(mod.tabNodeCard!(undefined, FACTS).env).toEqual([]);
    expect(mod.tabNodeCard!({ A: "1" }, undefined).facts).toEqual([]);
  });
});
