import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ClusterNode } from "../src/config/schema.js";
import type { GatewayApplyOptions } from "../src/workload/gateway-handlers/types.js";
import type { ModelRun } from "../src/workload/schema.js";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { readGatewayCatalog } from "../src/workload/gateway-catalog/io.js";
import { embersynthHandler } from "../src/workload/gateway-handlers/embersynth.js";

const node = {
  name: "em-1",
  endpoint: "http://em.test",
  kind: "gateway",
  cloud: { provider: "embersynth", baseUrl: "http://em.test" },
} as unknown as ClusterNode;

const manifest = {
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name: "m", labels: {}, annotations: {} },
  spec: {
    node: "em-1",
    enabled: true,
    target: { kind: "rel" as const, value: "fusion-vision" },
    extraArgs: [],
    timeoutSeconds: 60,
    workers: [],
    gateway: true,
    restartPolicy: "manual",
    allowExternalBind: false,
  },
} as unknown as ModelRun;

const composite: NonNullable<GatewayApplyOptions["composite"]> = {
  compositeName: "mc",
  upstreams: [{ name: "llama", endpoint: "http://h:1/v1", nodeName: "mac" }],
  providerConfig: { tags: ["vision"], priority: 3 },
};
const unusedGetClient: GatewayApplyOptions["getClient"] = () => {
  throw new Error("unused test client");
};

describe("embersynthHandler with composite context", () => {
  let tmp: string;
  let prevEm: string | undefined;
  let prevKc: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "eh-"));
    prevEm = process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    prevKc = process.env.LLAMACTL_CONFIG;

    process.env.LLAMACTL_EMBERSYNTH_CONFIG = join(tmp, "em.yaml");
    process.env.LLAMACTL_CONFIG = join(tmp, "kubeconfig");

    writeFileSync(
      process.env.LLAMACTL_CONFIG,
      stringifyYaml({
        apiVersion: "llamactl/v1",
        kind: "Config",
        currentContext: "default",
        contexts: [{ name: "default", cluster: "local", user: "admin" }],
        users: [{ name: "admin", token: "mock-token" }],
        clusters: [{ name: "local", server: "http://localhost" }],
      }),
    );

    origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response('{"ok":true}', { status: 200 }),
      )) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    if (prevEm === undefined) delete process.env.LLAMACTL_EMBERSYNTH_CONFIG;
    else process.env.LLAMACTL_EMBERSYNTH_CONFIG = prevEm;

    if (prevKc === undefined) delete process.env.LLAMACTL_CONFIG;
    else process.env.LLAMACTL_CONFIG = prevKc;

    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes a node entry before reload", async () => {
    await embersynthHandler.apply({
      manifest,
      node,
      getClient: unusedGetClient,
      composite,
    });
    const nodes = readGatewayCatalog("embersynth");
    const found = nodes.find((n) => n.id === "mc-llama");
    expect(found).toBeDefined();
    expect(found!.tags).toEqual(["vision"]);
    expect(found!.priority).toBe(3);
  });

  test("returns Pending NameCollision when operator entry exists with same id", async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      join(tmp, "em.yaml"),
      `nodes:
  - id: mc-llama
    label: hand-edited
    endpoint: http://other:1/v1
    transport: http
    enabled: true
    capabilities: []
    tags: []
    providerType: openai-compatible
    modelId: default
    priority: 5
profiles: []
syntheticModels: {}
server:
  host: 127.0.0.1
  port: 7777
`,
      "utf8",
    );
    const r = await embersynthHandler.apply({
      manifest,
      node,
      getClient: unusedGetClient,
      composite,
    });
    expect(r.action).toBe("pending");
    expect(r.statusSection.conditions[0]!.reason).toBe("EmbersynthUpstreamNameCollision");
  });

  test("idempotent re-apply skips reload", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(url instanceof Request ? url.url : url instanceof URL ? url.href : url);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await embersynthHandler.apply({ manifest, node, getClient: unusedGetClient, composite });
    const before = calls.length;
    await embersynthHandler.apply({ manifest, node, getClient: unusedGetClient, composite });
    expect(calls.length).toBe(before);
  });
});
