/**
 * Pin ClusterNodeSchema kind validation, ConfigSchema / ContextSchema
 * defaults, and DEFAULT_CLOUD_BASE_URLS.
 *
 * Part of #335
 */

import { describe, expect, test } from "bun:test";

import {
  CloudProviderSchema,
  ClusterNodeSchema,
  ClusterSchema,
  ConfigSchema,
  ContextSchema,
  DEFAULT_CLOUD_BASE_URLS,
  freshConfig,
} from "../../src/config/schema.js";

const REFINE_MSG =
  "agent nodes require endpoint; gateway nodes require cloud{} block; provider nodes require provider{} block; rag nodes require rag{} block and must not carry cloud/provider blocks; cli[] is agent-only";

const CLOUD = { provider: "openai" as const, baseUrl: "https://api.openai.com/v1" };
const PROVIDER = { gateway: "sirius" as const, providerName: "openai" as const };

describe("ClusterNodeSchema kind validation", () => {
  test("endpoint omitted on a bare node rejects with refine message", () => {
    const r = ClusterNodeSchema.safeParse({ name: "a" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: [], message: REFINE_MSG },
    ]);
  });

  test("endpoint present parses and data.endpoint is the value", () => {
    const r = ClusterNodeSchema.safeParse({ name: "a", endpoint: "https://a:7843" });
    expect(r.success).toBe(true);
    expect(r.data?.endpoint).toBe("https://a:7843");
  });

  test("explicit agent kind with cloud block but no endpoint rejects", () => {
    const r = ClusterNodeSchema.safeParse({ name: "a", kind: "agent", cloud: CLOUD });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: [], message: REFINE_MSG },
    ]);
  });

  test("no kind with cloud block infers gateway and parses", () => {
    const r = ClusterNodeSchema.safeParse({ name: "g", cloud: CLOUD });
    expect(r.success).toBe(true);
    expect(r.data?.endpoint).toBe("");
    expect(r.data?.cloud?.provider).toBe("openai");
  });

  test("explicit gateway kind without cloud block rejects", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "g",
      kind: "gateway",
      endpoint: "https://g:1",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: [], message: REFINE_MSG },
    ]);
  });

  test("legacy kind 'cloud' with endpoint rejects (treated as gateway)", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "c",
      kind: "cloud",
      endpoint: "https://c:1",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: [], message: REFINE_MSG },
    ]);
  });

  test("legacy kind 'cloud' with cloud block parses, kind preserved", () => {
    const r = ClusterNodeSchema.safeParse({ name: "c", kind: "cloud", cloud: CLOUD });
    expect(r.success).toBe(true);
    expect(r.data?.kind).toBe("cloud");
  });

  test("explicit provider kind with endpoint rejects", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "p",
      kind: "provider",
      endpoint: "https://p:1",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => ({ path: i.path, message: i.message }))).toEqual([
      { path: [], message: REFINE_MSG },
    ]);
  });

  test("no kind with provider block infers provider and parses", () => {
    const r = ClusterNodeSchema.safeParse({ name: "p", provider: PROVIDER });
    expect(r.success).toBe(true);
    expect(r.data?.provider?.providerName).toBe("openai");
  });

  test("bogus kind with endpoint rejects on 'kind' path", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "x",
      kind: "bogus",
      endpoint: "https://x:1",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(["kind"]);
  });
});

describe("ClusterNodeSchema nested binding checks", () => {
  test("invalid cloud provider is rejected", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "n",
      endpoint: "https://n:1",
      cloud: { provider: "azure" as never, baseUrl: "https://x/v1" },
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path);
    expect(paths).toContainEqual(["cloud", "provider"]);
  });

  test("invalid cloud baseUrl is rejected", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "n",
      endpoint: "https://n:1",
      cloud: { provider: "openai" as const, baseUrl: "not a url" },
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path);
    expect(paths).toContainEqual(["cloud", "baseUrl"]);
  });

  test("invalid provider source is rejected", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "n",
      endpoint: "https://n:1",
      provider: {
        gateway: "sirius" as const,
        providerName: "openai" as const,
        source: "bogus" as never,
      },
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path);
    expect(paths).toContainEqual(["provider", "source"]);
  });

  test("valid provider source 'cli' parses", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "n",
      endpoint: "https://n:1",
      provider: {
        gateway: "sirius" as const,
        providerName: "openai" as const,
        source: "cli" as const,
      },
    });
    expect(r.success).toBe(true);
    expect(r.data?.provider?.source).toBe("cli");
  });

  test("invalid facts.gpu.kind is rejected", () => {
    const r = ClusterNodeSchema.safeParse({
      name: "n",
      endpoint: "https://n:1",
      facts: { gpu: { kind: "npu" as never } },
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path);
    expect(paths).toContainEqual(["facts", "gpu", "kind"]);
  });
});

describe("ConfigSchema / ContextSchema / ClusterSchema", () => {
  test("valid minimal ConfigSchema returns defaults", () => {
    const r = ConfigSchema.safeParse({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "ctx-a",
    });
    expect(r.success).toBe(true);
    expect(r.data?.contexts).toEqual([]);
    expect(r.data?.clusters).toEqual([]);
    expect(r.data?.users).toEqual([]);
    expect(r.data?.currentContext).toBe("ctx-a");
  });

  test("invalid apiVersion is rejected", () => {
    const r = ConfigSchema.safeParse({
      apiVersion: "llamactl/v2" as never,
      kind: "Config",
      currentContext: "ctx-a",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(["apiVersion"]);
  });

  test("invalid kind is rejected", () => {
    const r = ConfigSchema.safeParse({
      apiVersion: "llamactl/v1",
      kind: "Cluster" as never,
      currentContext: "ctx-a",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(["kind"]);
  });

  test("ContextSchema keeps an explicit defaultNode", () => {
    const r = ContextSchema.safeParse({
      name: "c",
      cluster: "k",
      user: "u",
      defaultNode: "gpu-box",
    });
    expect(r.success).toBe(true);
    expect(r.data?.defaultNode).toBe("gpu-box");
  });

  test("ContextSchema defaultNode defaults to 'local' when omitted", () => {
    const r = ContextSchema.safeParse({
      name: "c",
      cluster: "k",
      user: "u",
    });
    expect(r.success).toBe(true);
    expect(r.data?.defaultNode).toBe("local");
  });

  test("ContextSchema rejects invalid tunnelCentralUrl", () => {
    const r = ContextSchema.safeParse({
      name: "c",
      cluster: "k",
      user: "u",
      tunnelCentralUrl: "not-a-url",
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path)).toContainEqual(["tunnelCentralUrl"]);
  });

  test("ContextSchema accepts valid tunnelCentralUrl", () => {
    const r = ContextSchema.safeParse({
      name: "c",
      cluster: "k",
      user: "u",
      tunnelCentralUrl: "https://127.0.0.1:7843",
    });
    expect(r.success).toBe(true);
    expect(r.data?.tunnelCentralUrl).toBe("https://127.0.0.1:7843");
  });

  test("ClusterSchema with no nodes defaults to empty array", () => {
    const r = ClusterSchema.safeParse({ name: "lan" });
    expect(r.success).toBe(true);
    expect(r.data?.nodes).toEqual([]);
  });

  test("freshConfig() parses back to itself", () => {
    const cfg = freshConfig();
    const r = ConfigSchema.safeParse(cfg);
    expect(r.success).toBe(true);
    expect(r.data).toEqual(cfg);
  });
});

describe("DEFAULT_CLOUD_BASE_URLS", () => {
  test("keys match CloudProviderSchema.options", () => {
    expect(Object.keys(DEFAULT_CLOUD_BASE_URLS).sort()).toEqual(
      [...CloudProviderSchema.options].sort(),
    );
  });

  test("specific provider URLs match production defaults", () => {
    expect(DEFAULT_CLOUD_BASE_URLS.gemini).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
    expect(DEFAULT_CLOUD_BASE_URLS.groq).toBe("https://api.groq.com/openai/v1");
    expect(DEFAULT_CLOUD_BASE_URLS.sirius).toBe("http://localhost:3000/v1");
    expect(DEFAULT_CLOUD_BASE_URLS.embersynth).toBe("http://localhost:7777/v1");
  });
});
