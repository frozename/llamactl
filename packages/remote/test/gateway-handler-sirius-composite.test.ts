import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ClusterNode } from "../src/config/schema.js";
import type { ModelRun } from "../src/workload/schema.js";
import type { GatewayApplyOptions } from "../src/workload/gateway-handlers/types.js";

import { readGatewayCatalog } from "../src/workload/gateway-catalog/io.js";
import { siriusHandler } from "../src/workload/gateway-handlers/sirius.js";

const node = {
  name: "sirius-1",
  endpoint: "http://sirius.test",
  kind: "gateway",
  cloud: { provider: "sirius", baseUrl: "http://sirius.test" },
} as unknown as ClusterNode;

const manifest = {
  apiVersion: "llamactl/v1",
  kind: "ModelRun",
  metadata: { name: "m", labels: {}, annotations: {} },
  spec: {
    node: "sirius-1",
    enabled: true,
    target: { kind: "rel" as const, value: "mc-llama/x" },
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
  providerConfig: {},
};
const unusedGetClient: GatewayApplyOptions["getClient"] = () => {
  throw new Error("unused test client");
};

describe("siriusHandler with composite context", () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevKc: string | undefined;
  let origFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "sh-"));
    prevSp = process.env.LLAMACTL_SIRIUS_PROVIDERS;
    prevKc = process.env.LLAMACTL_CONFIG;

    process.env.LLAMACTL_SIRIUS_PROVIDERS = join(tmp, "sp.yaml");
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
    if (prevSp === undefined) delete process.env.LLAMACTL_SIRIUS_PROVIDERS;
    else process.env.LLAMACTL_SIRIUS_PROVIDERS = prevSp;

    if (prevKc === undefined) delete process.env.LLAMACTL_CONFIG;
    else process.env.LLAMACTL_CONFIG = prevKc;

    globalThis.fetch = origFetch;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("writes entries before reload", async () => {
    await siriusHandler.apply({
      manifest,
      node,
      getClient: unusedGetClient,
      composite,
    });
    const out = readGatewayCatalog("sirius");
    expect(out.find((e) => e.name === "mc-llama")).toBeDefined();
  });

  test("returns Pending NameCollision when operator entry exists with same name", async () => {
    const path = join(tmp, "sp.yaml");
    writeFileSync(
      path,
      "apiVersion: llamactl/v1\nkind: SiriusProviderList\nproviders:\n  - name: mc-llama\n    kind: openai\n    apiKeyRef: $K\n",
      "utf8",
    );
    const r = await siriusHandler.apply({
      manifest,
      node,
      getClient: unusedGetClient,
      composite,
    });
    expect(r.action).toBe("pending");
    expect(r.statusSection.conditions[0]!.reason).toBe("SiriusUpstreamNameCollision");
  });

  test("idempotent re-apply skips reload", async () => {
    const calls: string[] = [];
    globalThis.fetch = ((url: Parameters<typeof globalThis.fetch>[0]) => {
      calls.push(url instanceof Request ? url.url : url instanceof URL ? url.href : url);
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }) as unknown as typeof globalThis.fetch;
    await siriusHandler.apply({ manifest, node, getClient: unusedGetClient, composite });
    const before = calls.length;
    await siriusHandler.apply({ manifest, node, getClient: unusedGetClient, composite });
    expect(calls.length).toBe(before); // no new reload on second apply
  });
});
