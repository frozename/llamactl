import type { ClusterNode } from "@llamactl/core/config/schema";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ModelRun } from "../src/workload/schema.js";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { siriusHandler } from "../src/workload/gateway-handlers/sirius.js";

/**
 * I.5 / #335 — pin untested sirius-handler validation paths:
 * target format, upstream lookup, baseUrl, token resolution and
 * reload HTTP.  No Bun.serve is started; globalThis.fetch is
 * stubbed so the handler's POST is the only observable side
 * effect.
 */

let runtimeDir = "";
const originalEnv = { ...process.env };
let originalFetch: typeof globalThis.fetch;
const calls: { url: string; init?: RequestInit }[] = [];
const onEvents: { type: string; message: string }[] = [];

function recordFetch(input: string | URL, init?: RequestInit): void {
  calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
}

function defaultFetch(): typeof globalThis.fetch {
  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    recordFetch(input, init);
    return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
  }) as unknown as typeof globalThis.fetch;
}

function failingFetch(status: number, body: string): typeof globalThis.fetch {
  return ((input: string | URL, init?: RequestInit): Promise<Response> => {
    recordFetch(input, init);
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-sirius-validation-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(runtimeDir, "kubeconfig"),
    LLAMACTL_SIRIUS_PROVIDERS: join(runtimeDir, "sirius-providers.yaml"),
    LLAMACTL_EMBERSYNTH_CONFIG: join(runtimeDir, "embersynth.yaml"),
  });
  originalFetch = globalThis.fetch;
  calls.length = 0;
  onEvents.length = 0;
  globalThis.fetch = defaultFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(runtimeDir, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

function gatewayManifest(target: string): ModelRun {
  return {
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name: "register-sirius", labels: {}, annotations: {} },
    spec: {
      node: "sirius-primary",
      enabled: true,
      gateway: true,
      target: { kind: "rel", value: target },
      extraArgs: [],
      workers: [],
      restartPolicy: "Always",
      allowExternalBind: false,
      timeoutSeconds: 60,
    },
  };
}

function siriusNode(baseUrl = "http://sirius.test:7000"): ClusterNode {
  return {
    name: "sirius-primary",
    endpoint: "",
    kind: "gateway",
    cloud: { provider: "sirius", baseUrl },
  };
}

function seedKubeconfig(user = "me"): void {
  writeFileSync(
    join(runtimeDir, "kubeconfig"),
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "default",
      contexts: [{ name: "default", cluster: "home", user }],
      clusters: [{ name: "home", nodes: [] }],
      users: [{ name: "me", token: "fake-demo-token" }],
    }),
  );
}

function seedProviders(list: readonly { name: string; kind: string }[]): void {
  writeFileSync(
    join(runtimeDir, "sirius-providers.yaml"),
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "SiriusProviderList",
      providers: list,
    }),
  );
}

function getClient(): never {
  throw new Error("should not call getClient for sirius path");
}

describe("siriusHandler — target validation", () => {
  test("1. target with no slash → Failed + SiriusTargetMalformed", async () => {
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusTargetMalformed");
    expect(result.statusSection.conditions[0]?.message).toContain("'gpt-4o'");
    expect(calls).toHaveLength(0);
  });

  test("2. leading slash only → Failed + SiriusTargetMalformed", async () => {
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("/gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusTargetMalformed");
  });

  test("3. ordering: missing baseUrl checked after target format", async () => {
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("gpt-4o"),
      node: siriusNode(""),
      getClient,
    });
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusTargetMalformed");
  });
});

describe("siriusHandler — upstream validation", () => {
  test("4. missing upstream → Pending + SiriusUpstreamMissing (action is 'pending' on both paths)", async () => {
    seedKubeconfig();
    seedProviders([{ name: "anthropic", kind: "anthropic" }]);
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Pending");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusUpstreamMissing");
    expect(result.statusSection.conditions[0]?.message).toContain("'openai'");
    expect(result.statusSection.conditions[0]?.message).toContain(
      "llamactl sirius add-provider openai",
    );
    expect(calls).toHaveLength(0);
  });

  test("5. absent providers file defers validation", async () => {
    seedKubeconfig();
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(),
      getClient,
      onEvent: (e) => onEvents.push(e),
    });
    expect(calls).toHaveLength(1);
    expect(result.statusSection.phase).toBe("Running");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusReloaded");
    expect(onEvents.find((e) => e.message.includes("deferring upstream validation"))).toBeDefined();
  });
});

describe("siriusHandler — providers file errors", () => {
  test("6. unreadable providers → Failed + SiriusProvidersUnreadable", async () => {
    seedKubeconfig();
    writeFileSync(
      join(runtimeDir, "sirius-providers.yaml"),
      stringifyYaml({
        apiVersion: "llamactl/v1",
        kind: "SiriusProviderList",
        providers: [{ name: "openai", kind: "bogus" }],
      }),
    );
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusProvidersUnreadable");
    expect(result.statusSection.conditions[0]?.message).toMatch(
      /^failed to read sirius-providers\.yaml/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("siriusHandler — baseUrl validation", () => {
  test("7. missing baseUrl → Failed + SiriusBaseUrlMissing", async () => {
    seedKubeconfig();
    seedProviders([{ name: "openai", kind: "openai" }]);
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(""),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusBaseUrlMissing");
    expect(result.statusSection.conditions[0]?.message).toContain("'sirius-primary'");
    expect(calls).toHaveLength(0);
  });
});

describe("siriusHandler — token resolution", () => {
  test("8. plain-path token (user mismatch) → Failed + SiriusTokenUnresolved", async () => {
    seedKubeconfig("ghost");
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode("http://sirius.test:7000"),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusTokenUnresolved");
    expect(result.statusSection.conditions[0]?.message).toContain("ghost");
    expect(calls).toHaveLength(0);
  });
});

describe("siriusHandler — normalizeBaseUrl", () => {
  test.each([
    "http://sirius.test:7000/v1",
    "http://sirius.test:7000/v1/",
    "http://sirius.test:7000/",
  ])("normalizeBaseUrl strips trailing /v1 — url=%s", async (baseUrl) => {
    seedKubeconfig();
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(baseUrl),
      getClient,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://sirius.test:7000/providers/reload");
    expect(calls[0]?.init?.method).toBe("POST");
    const authHeader = new Headers(calls[0]?.init?.headers).get("authorization");
    expect(authHeader).toBe("Bearer fake-demo-token");
    expect(result.statusSection.endpoint).toBe("http://sirius.test:7000/v1/chat/completions");
  });
});

describe("siriusHandler — reload error handling", () => {
  test("10. non-2xx body truncation (500 chars)", async () => {
    const errorBody = "x".repeat(600);
    globalThis.fetch = failingFetch(502, errorBody);

    seedKubeconfig();
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.reason).toBe("SiriusReloadFailed");
    const msg10 = result.statusSection.conditions[0]?.message ?? "";
    expect(msg10).toContain(`: ${"x".repeat(500)}`);
    expect(msg10).not.toContain("x".repeat(501));
  });

  test("11. non-2xx with empty body", async () => {
    globalThis.fetch = failingFetch(500, "");

    seedKubeconfig();
    const result = await siriusHandler.apply({
      manifest: gatewayManifest("openai/gpt-4o"),
      node: siriusNode(),
      getClient,
    });
    expect(result.statusSection.phase).toBe("Failed");
    expect(result.statusSection.conditions[0]?.message).toMatch(/returned 500$/);
    expect(result.statusSection.conditions[0]?.message).not.toMatch(/: $/);
  });
});
