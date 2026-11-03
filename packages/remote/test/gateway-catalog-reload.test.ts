// packages/remote/test/gateway-catalog-reload.test.ts
// Issue #335 — pins reloadAllGatewayNodesOfKind: node selection, the
// kind-specific reload paths, bearer resolution, cluster walk order
// and best-effort semantics. The fetch mock is the whole network.
import type { CloudProvider, ClusterNode, Config } from "@llamactl/core/config/schema";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { reloadAllGatewayNodesOfKind } from "../src/workload/gateway-catalog/reload.js";

interface RecordedCall {
  url: string;
  method: string | undefined;
  headers: RequestInit["headers"];
}

let tmp = "";
let prevConfig: string | undefined;
let prevKey: string | undefined;
let origFetch: typeof globalThis.fetch;
let calls: RecordedCall[] = [];
let rejectUrls = new Set<string>();
let unavailableUrls = new Set<string>();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-gw-reload-"));
  prevConfig = process.env["LLAMACTL_CONFIG"];
  prevKey = process.env["LLAMACTL_TEST_GW_RELOAD_KEY"];
  process.env["LLAMACTL_CONFIG"] = join(tmp, "kubeconfig");
  calls = [];
  rejectUrls = new Set();
  unavailableUrls = new Set();
  origFetch = globalThis.fetch;
  globalThis.fetch = ((input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    calls.push({ url, method: init?.method, headers: init?.headers });
    if (rejectUrls.has(url)) return Promise.reject(new Error("ECONNREFUSED"));
    if (unavailableUrls.has(url))
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    return Promise.resolve(new Response("ok", { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevConfig === undefined) delete process.env["LLAMACTL_CONFIG"];
  else process.env["LLAMACTL_CONFIG"] = prevConfig;
  if (prevKey === undefined) delete process.env["LLAMACTL_TEST_GW_RELOAD_KEY"];
  else process.env["LLAMACTL_TEST_GW_RELOAD_KEY"] = prevKey;
  rmSync(tmp, { recursive: true, force: true });
});

function seedKubeconfig(clusters: Config["clusters"]): void {
  writeFileSync(
    join(tmp, "kubeconfig"),
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: clusters[0]?.name ?? "c1", user: "me" }],
      clusters,
      users: [{ name: "me", token: "unused" }],
    }),
  );
}

function gatewayNode(
  name: string,
  provider: CloudProvider,
  baseUrl: string,
  apiKeyRef?: string,
): ClusterNode {
  return {
    name,
    endpoint: "",
    kind: "gateway",
    cloud: { provider, baseUrl, ...(apiKeyRef === undefined ? {} : { apiKeyRef }) },
  };
}

function siriusNodes(...names: string[]): ClusterNode[] {
  return names.map((n) => gatewayNode(n, "sirius", `http://${n}.test:3000`));
}

function reloadUrl(nodeName: string, path: string): string {
  return `http://${nodeName}.test:3000${path}`;
}

function recordedUrls(): string[] {
  return calls.map((c) => c.url);
}

describe("reloadAllGatewayNodesOfKind", () => {
  test("sirius gateway gets exactly one POST to /providers/reload", async () => {
    seedKubeconfig([
      { name: "c1", nodes: [gatewayNode("sirius-a", "sirius", "http://sirius-a.test:3000")] },
    ]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://sirius-a.test:3000/providers/reload");
    expect(calls[0]!.method).toBe("POST");
  });

  test("embersynth gateway gets exactly one POST to /config/reload", async () => {
    seedKubeconfig([
      { name: "c1", nodes: [gatewayNode("ember-a", "embersynth", "http://ember-a.test:7777")] },
    ]);
    await reloadAllGatewayNodesOfKind("embersynth");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://ember-a.test:7777/config/reload");
    expect(calls[0]!.method).toBe("POST");
  });

  test("kind filtering reloads only the matching gateway provider", async () => {
    const nodes: ClusterNode[] = [
      gatewayNode("sirius-a", "sirius", "http://sirius-a.test:3000"),
      gatewayNode("ember-a", "embersynth", "http://ember-a.test:7777"),
      gatewayNode("compat-a", "openai-compatible", "http://compat-a.test:8080"),
      {
        name: "openai-direct",
        endpoint: "",
        cloud: { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      },
      { name: "a1", endpoint: "https://a1.test:7843" },
    ];
    seedKubeconfig([{ name: "c1", nodes }]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(recordedUrls()).toEqual(["http://sirius-a.test:3000/providers/reload"]);
    calls.length = 0;
    await reloadAllGatewayNodesOfKind("embersynth");
    expect(recordedUrls()).toEqual(["http://ember-a.test:7777/config/reload"]);
  });

  test("explicit agent and legacy cloud kinds are never reloaded", async () => {
    const nodes: ClusterNode[] = [
      {
        name: "ag",
        kind: "agent",
        endpoint: "https://ag.test:7843",
        cloud: { provider: "sirius", baseUrl: "http://ag-sirius.test:3000" },
      },
      {
        name: "legacy",
        kind: "cloud",
        endpoint: "",
        cloud: { provider: "sirius", baseUrl: "http://legacy-sirius.test:3000" },
      },
    ];
    seedKubeconfig([{ name: "c1", nodes }]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(calls).toHaveLength(0);
  });

  test("bearer is sent only when cloud.apiKeyRef resolves", async () => {
    process.env["LLAMACTL_TEST_GW_RELOAD_KEY"] = "k-123";
    seedKubeconfig([
      {
        name: "c1",
        nodes: [
          gatewayNode(
            "sirius-keyed",
            "sirius",
            "http://sirius-keyed.test:3000",
            "env:LLAMACTL_TEST_GW_RELOAD_KEY",
          ),
          gatewayNode("sirius-open", "sirius", "http://sirius-open.test:3000"),
        ],
      },
    ]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(calls).toHaveLength(2);
    const keyed = calls.find((c) => c.url === "http://sirius-keyed.test:3000/providers/reload");
    const open = calls.find((c) => c.url === "http://sirius-open.test:3000/providers/reload");
    expect(keyed?.headers).toEqual({ Authorization: "Bearer k-123" });
    expect(open?.headers).toEqual({});
  });

  test("walks every cluster in seeded order regardless of context", async () => {
    seedKubeconfig([
      { name: "c1", nodes: siriusNodes("a", "b") },
      { name: "c2", nodes: siriusNodes("c") },
    ]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(recordedUrls()).toEqual([
      reloadUrl("a", "/providers/reload"),
      reloadUrl("b", "/providers/reload"),
      reloadUrl("c", "/providers/reload"),
    ]);
  });

  test("a rejecting fetch is swallowed and later nodes are still called", async () => {
    rejectUrls.add(reloadUrl("a", "/providers/reload"));
    seedKubeconfig([{ name: "c1", nodes: siriusNodes("a", "b", "c") }]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(recordedUrls()).toEqual([
      reloadUrl("a", "/providers/reload"),
      reloadUrl("b", "/providers/reload"),
      reloadUrl("c", "/providers/reload"),
    ]);
  });

  test("a 503 response is ignored and later nodes are still called", async () => {
    unavailableUrls.add(reloadUrl("a", "/providers/reload"));
    seedKubeconfig([{ name: "c1", nodes: siriusNodes("a", "b", "c") }]);
    await reloadAllGatewayNodesOfKind("sirius");
    expect(recordedUrls()).toEqual([
      reloadUrl("a", "/providers/reload"),
      reloadUrl("b", "/providers/reload"),
      reloadUrl("c", "/providers/reload"),
    ]);
  });

  test("missing config file resolves with zero calls", async () => {
    await reloadAllGatewayNodesOfKind("sirius");
    expect(calls).toHaveLength(0);
  });

  test("cluster with no nodes resolves with zero calls", async () => {
    seedKubeconfig([{ name: "c1", nodes: [] }]);
    await reloadAllGatewayNodesOfKind("embersynth");
    expect(calls).toHaveLength(0);
  });
});
