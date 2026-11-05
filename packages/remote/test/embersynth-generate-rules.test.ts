// #335: pin untested embersynth config generation rules: bench selection,
// priority band edges, agent/sirius node projection, existing-config merge,
// default path.

import type { schemas } from "@llamactl/core";
import type { Config } from "@llamactl/core/config/schema";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import {
  DEFAULT_EMBERSYNTH_PROFILES,
  defaultEmbersynthConfigPath,
  type EmbersynthConfig,
  EmbersynthConfigSchema,
  type EmbersynthNode,
  generateEmbersynthConfig,
  loadEmbersynthConfig,
  saveEmbersynthConfig,
} from "../src/config/embersynth.js";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

let tmp = "";
const originalEnv: NodeJS.ProcessEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-embersynth-"));
  process.env["DEV_STORAGE"] = tmp;
  process.env["LLAMACTL_CONFIG"] = join(tmp, "kubeconfig");
  process.env["LLAMACTL_SIRIUS_PROVIDERS"] = join(tmp, "sirius-providers.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
});

const DEFAULT_AGENT = { name: "gpu1", endpoint: "https://gpu1.lan:7843" };

function cfgWith(
  nodes: Config["clusters"][number]["nodes"] = [DEFAULT_AGENT],
  users: Config["users"] = [{ name: "me", token: "agent-bearer" }],
  ctxUser = "me",
): Config {
  return {
    apiVersion: "llamactl/v1",
    kind: "Config",
    currentContext: "default",
    contexts: [{ name: "default", cluster: "home", user: ctxUser, defaultNode: "local" }],
    clusters: [{ name: "home", nodes }],
    users,
  };
}

function row(
  machine: string,
  gen_ts: string,
  rel = "x/y.gguf",
  ctx = "8192",
): schemas.BenchHistoryEntry {
  return {
    updated_at: "2026-04-01T00:00:00Z",
    machine,
    rel,
    mode: "text",
    ctx,
    build: "b1",
    profile: "p",
    gen_ts,
    prompt_ts: "100",
    launch_args: "",
  };
}

function agentNode(out: EmbersynthConfig, id: string): EmbersynthNode | undefined {
  return out.nodes.find((n) => n.id === id);
}

function writeSirius(
  providers: {
    name: string;
    kind: string;
    baseUrl?: string;
    apiKeyRef?: string;
  }[],
): void {
  writeFileSync(
    process.env["LLAMACTL_SIRIUS_PROVIDERS"]!,
    stringifyYaml({
      apiVersion: "llamactl/v1",
      kind: "SiriusProviderList",
      providers,
    }),
  );
}

describe("bench-driven priority", () => {
  test.each([
    ["60", 1],
    ["59.9", 2],
    ["30", 2],
    ["29.9", 4],
    ["15", 4],
    ["14.9", 6],
    ["5", 6],
    ["4.9", 8],
  ])('band edge gen_ts "%s" -> priority %s', (gen_ts, expectedPriority) => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", gen_ts)],
      env: {},
    });
    expect(agentNode(out, "agent-gpu1")?.priority).toBe(expectedPriority);
  });

  test.each(["n/a", "0", "-5", "Infinity"])("invalid gen_ts '%s' is skipped", (gen_ts) => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [row("gpu1", gen_ts)],
      env: {},
    });
    const gpu1 = agentNode(out, "agent-gpu1");
    expect(gpu1?.priority).toBe(5);
    expect(gpu1?.modelId).toBe("default");
    expect(gpu1?.optimization).toBeUndefined();
  });

  test("only rows whose machine equals the node name count", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([
        { name: "gpu1", endpoint: "https://gpu1.lan:7843" },
        { name: "gpu2", endpoint: "https://gpu2.lan:7843" },
      ]),
      benchHistory: [row("gpu2", "72", "fast.gguf")],
      env: {},
    });
    const gpu1 = agentNode(out, "agent-gpu1");
    const gpu2 = agentNode(out, "agent-gpu2");
    expect(gpu1?.priority).toBe(5);
    expect(gpu1?.modelId).toBe("default");
    expect(gpu2?.priority).toBe(1);
    expect(gpu2?.modelId).toBe("fast.gguf");
  });

  test("the highest gen_ts wins regardless of position", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [
        row("gpu1", "20", "a.gguf", "4096"),
        row("gpu1", "70", "b.gguf", "16384"),
        row("gpu1", "40", "c.gguf", "8192"),
      ],
      env: {},
    });
    const gpu1 = agentNode(out, "agent-gpu1");
    expect(gpu1?.priority).toBe(1);
    expect(gpu1?.modelId).toBe("b.gguf");
    expect(gpu1?.optimization?.contextWindow).toBe(16384);
  });

  test("a tie keeps the first row", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [
        row("gpu1", "30", "first.gguf", "4096"),
        row("gpu1", "30", "second.gguf", "8192"),
      ],
      env: {},
    });
    const gpu1 = agentNode(out, "agent-gpu1");
    expect(gpu1?.modelId).toBe("first.gguf");
    expect(gpu1?.optimization?.contextWindow).toBe(4096);
  });

  test.each(["auto", "0", "-5"])(
    "non-positive or non-numeric ctx '%s' drops optimization",
    (ctx) => {
      const out = generateEmbersynthConfig({
        cfg: cfgWith(),
        benchHistory: [row("gpu1", "72", "m.gguf", ctx)],
        env: {},
      });
      const gpu1 = agentNode(out, "agent-gpu1");
      expect(gpu1?.priority).toBe(1);
      expect(gpu1?.modelId).toBe("m.gguf");
      expect(gpu1?.optimization).toBeUndefined();
    },
  );
});

describe("agent node projection", () => {
  test("full shape for an agent with no bench data", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([{ name: "gpu1", endpoint: "https://gpu1.lan:7843/" }]),
      benchHistory: [],
      env: {},
    });
    expect(agentNode(out, "agent-gpu1")).toEqual({
      id: "agent-gpu1",
      label: "llamactl agent 'gpu1'",
      endpoint: "https://gpu1.lan:7843/v1",
      transport: "http",
      enabled: true,
      capabilities: ["reasoning"],
      tags: ["llamactl", "agent", "local", "private"],
      providerType: "openai-compatible",
      modelId: "default",
      priority: 5,
      auth: { type: "bearer", token: "agent-bearer" },
      health: { endpoint: "/health", intervalMs: 30000 },
    });
  });

  test("non-agent kinds are skipped", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([
        { name: "gw", endpoint: "https://gw.lan:8443", kind: "gateway" },
        { name: "prov", endpoint: "https://p.lan", kind: "provider" },
        DEFAULT_AGENT,
      ]),
      benchHistory: [],
      env: {},
    });
    const agentIds = out.nodes.filter((n) => n.id.startsWith("agent-")).map((n) => n.id);
    expect(agentIds).toEqual(["agent-gpu1"]);
  });

  test("agents keep cluster order", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([
        { name: "gpu2", endpoint: "https://gpu2.lan:7843" },
        { name: "gpu1", endpoint: "https://gpu1.lan:7843" },
      ]),
      benchHistory: [],
      env: {},
    });
    const agentIds = out.nodes.filter((n) => n.id.startsWith("agent-")).map((n) => n.id);
    expect(agentIds).toEqual(["agent-gpu2", "agent-gpu1"]);
  });

  test("a context user missing from users yields no agent nodes", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([DEFAULT_AGENT], [{ name: "other", token: "x" }], "ghost"),
      benchHistory: [],
      env: {},
    });
    const agentIds = out.nodes.filter((n) => n.id.startsWith("agent-")).map((n) => n.id);
    expect(agentIds).toEqual([]);
  });

  test("a tokenRef resolves through opts.env and is trimmed", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([DEFAULT_AGENT], [{ name: "me", tokenRef: "env:EMBERSYNTH_RULES_TOKEN" }]),
      benchHistory: [],
      env: { EMBERSYNTH_RULES_TOKEN: "  tok-from-env\n" },
    });
    expect(agentNode(out, "agent-gpu1")?.auth).toEqual({
      type: "bearer",
      token: "tok-from-env",
    });
  });

  test("an unresolvable tokenRef skips the agent without throwing", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith([DEFAULT_AGENT], [{ name: "me", tokenRef: "env:EMBERSYNTH_RULES_TOKEN" }]),
      benchHistory: [],
      env: {},
    });
    const agentIds = out.nodes.filter((n) => n.id.startsWith("agent-")).map((n) => n.id);
    expect(agentIds).toEqual([]);
  });

  test("only the current context's cluster is projected", () => {
    const cfg: Config = {
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "work",
      contexts: [
        { name: "default", cluster: "home", user: "me", defaultNode: "local" },
        { name: "work", cluster: "lab", user: "me", defaultNode: "lab1" },
      ],
      clusters: [
        { name: "home", nodes: [DEFAULT_AGENT] },
        {
          name: "lab",
          nodes: [{ name: "lab1", endpoint: "https://lab1.lan:7843" }],
        },
      ],
      users: [{ name: "me", token: "agent-bearer" }],
    };
    const out = generateEmbersynthConfig({ cfg, benchHistory: [], env: {} });
    const agentIds = out.nodes.filter((n) => n.id.startsWith("agent-")).map((n) => n.id);
    expect(agentIds).toEqual(["agent-lab1"]);
  });
});

describe("sirius provider projection", () => {
  test("a provider with no baseUrl is skipped", () => {
    writeSirius([{ name: "openai", kind: "openai", apiKeyRef: "$OPENAI_API_KEY" }]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.find((n) => n.id === "provider-openai")).toBeUndefined();
  });

  test("a missing apiKeyRef gives auth {type:'none'}", () => {
    writeSirius([
      {
        name: "lan",
        kind: "openai-compatible",
        baseUrl: "http://gpu-host.lan:8000/v1",
      },
    ]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.find((n) => n.id === "provider-lan")?.auth).toEqual({
      type: "none",
    });
  });

  test("a trailing slash on baseUrl is stripped", () => {
    writeSirius([
      {
        name: "lan",
        kind: "openai-compatible",
        baseUrl: "http://gpu-host.lan:8000/v1/",
      },
    ]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.find((n) => n.id === "provider-lan")?.endpoint).toBe(
      "http://gpu-host.lan:8000/v1",
    );
  });

  test("fixed fields: label, tags, priority, modelId", () => {
    writeSirius([
      {
        name: "lan",
        kind: "openai-compatible",
        baseUrl: "http://gpu-host.lan:8000/v1",
      },
    ]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    const provider = out.nodes.find((n) => n.id === "provider-lan");
    expect(provider?.label).toBe("openai-compatible (via sirius)");
    expect(provider?.tags).toEqual(["cloud", "openai-compatible"]);
    expect(provider?.priority).toBe(10);
    expect(provider?.modelId).toBe("default");
  });

  test.each(["together", "groq", "mistral"])(
    "capabilities for kind '%s' equal ['reasoning']",
    (kind) => {
      writeSirius([{ name: "ext", kind, baseUrl: "https://api.example.com/v1" }]);
      const out = generateEmbersynthConfig({
        cfg: cfgWith(),
        benchHistory: [],
        env: {},
      });
      expect(out.nodes.find((n) => n.id === "provider-ext")?.capabilities).toEqual(["reasoning"]);
    },
  );

  test("a providers file that fails validation gives no provider- nodes", () => {
    writeSirius([{ name: "x", kind: "bogus", baseUrl: "https://x.example/v1" }]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.filter((n) => n.id.startsWith("provider-")).map((n) => n.id)).toEqual([]);
    expect(agentNode(out, "agent-gpu1")).toBeTruthy();
  });

  test("agents come before providers", () => {
    writeSirius([
      {
        name: "lan",
        kind: "openai-compatible",
        baseUrl: "http://gpu-host.lan:8000/v1",
      },
    ]);
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.map((n) => n.id)).toEqual(["agent-gpu1", "provider-lan"]);
  });
});

describe("merge with an existing config", () => {
  test("existing profiles [] falls back to DEFAULT_EMBERSYNTH_PROFILES", () => {
    const existing = EmbersynthConfigSchema.parse({ profiles: [] });
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      existing,
      benchHistory: [],
      env: {},
    });
    expect(out.profiles.map((p) => p.id)).toEqual(DEFAULT_EMBERSYNTH_PROFILES.map((p) => p.id));
  });

  test("non-empty existing profiles replace the defaults wholesale", () => {
    const existing = EmbersynthConfigSchema.parse({
      profiles: [{ id: "custom", label: "Custom" }],
    });
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      existing,
      benchHistory: [],
      env: {},
    });
    expect(out.profiles.map((p) => p.id)).toEqual(["custom"]);
  });

  test("empty existing syntheticModels are derived from profiles in effect", () => {
    const existing = EmbersynthConfigSchema.parse({
      profiles: [{ id: "custom", label: "Custom" }],
    });
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      existing,
      benchHistory: [],
      env: {},
    });
    expect(out.syntheticModels).toEqual({ "fusion-custom": "custom" });
  });

  test("existing server and policy are kept as-is", () => {
    const existing = EmbersynthConfigSchema.parse({
      server: { host: "0.0.0.0", port: 9000 },
      policy: {
        fallbackEnabled: false,
        maxRetries: 0,
        retryDelayMs: 0,
        requireHealthy: false,
      },
    });
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      existing,
      benchHistory: [],
      env: {},
    });
    expect(out.server).toEqual({ host: "0.0.0.0", port: 9000 });
    expect(out.policy).toEqual({
      fallbackEnabled: false,
      maxRetries: 0,
      retryDelayMs: 0,
      requireHealthy: false,
    });
  });

  test("with no existing config: defaults for server and policy", () => {
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      benchHistory: [],
      env: {},
    });
    expect(out.server).toEqual({ host: "127.0.0.1", port: 7777 });
    expect(out.policy).toEqual({
      fallbackEnabled: true,
      maxRetries: 2,
      retryDelayMs: 500,
      requireHealthy: true,
    });
  });

  test("existing nodes are never carried over", () => {
    const existing = EmbersynthConfigSchema.parse({
      nodes: [{ id: "stale-node", label: "s", endpoint: "http://s" }],
    });
    const out = generateEmbersynthConfig({
      cfg: cfgWith(),
      existing,
      benchHistory: [],
      env: {},
    });
    expect(out.nodes.map((n) => n.id)).not.toContain("stale-node");
  });
});

describe("storage", () => {
  test("LLAMACTL_EMBERSYNTH_CONFIG wins and is trimmed", () => {
    expect(
      defaultEmbersynthConfigPath({
        LLAMACTL_EMBERSYNTH_CONFIG: "  /x/e.yaml  ",
        DEV_STORAGE: "/d",
      }),
    ).toBe("/x/e.yaml");
  });

  test("a whitespace-only override falls back to DEV_STORAGE", () => {
    expect(
      defaultEmbersynthConfigPath({
        LLAMACTL_EMBERSYNTH_CONFIG: "   ",
        DEV_STORAGE: "/d",
      }),
    ).toBe("/d/embersynth.yaml");
  });

  test("with neither variable set the path lands under ~/.llamactl", () => {
    expect(defaultEmbersynthConfigPath({})).toBe(join(homedir(), ".llamactl", "embersynth.yaml"));
  });

  test("loadEmbersynthConfig on an empty file returns defaults", () => {
    const path = join(tmp, "empty-embersynth.yaml");
    writeFileSync(path, "", "utf8");
    expect(loadEmbersynthConfig(path)).toEqual({
      server: { host: "127.0.0.1", port: 7777 },
      nodes: [],
      profiles: [],
      syntheticModels: {},
      policy: undefined,
    });
  });

  test("saveEmbersynthConfig with an empty-string node id throws before writing", () => {
    const path = join(tmp, "bad-embersynth.yaml");
    expect(existsSync(path)).toBe(false);
    const bad = {
      nodes: [{ id: "", label: "bad", endpoint: "http://bad" }],
    } as unknown as EmbersynthConfig;
    expect(() => {
      saveEmbersynthConfig(bad, path);
    }).toThrow();
    expect(existsSync(path)).toBe(false);
  });
});
