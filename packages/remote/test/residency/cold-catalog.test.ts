/**
 * #280 DF-07 — declared cold catalog. `src/residency/catalog` lands with
 * the fix, so its exports are reached through a guarded dynamic import:
 * at base the module is absent, `.catch` yields {}, and each case fails
 * by assertion — never by a missing module or a type error. The specifier
 * stays a `string` (not a literal) so `tsc` cannot resolve it at base.
 * The core seam uses the same structural cast as the core tests.
 */
import { openaiProxy, routingCatalog } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

import type { ModelHostManifest } from "../../src/workload/modelhost-schema.js";
import type { ModelRun } from "../../src/workload/schema.js";

import { createProxy } from "../../src/proxy/create-proxy.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../../src/safe-fs.js";
import { ModelHostManifestSchema } from "../../src/workload/modelhost-schema.js";
import { ModelRunSchema } from "../../src/workload/schema.js";

// Widened to `string` on purpose: a literal specifier would let `tsc`
// resolve (and fail on) the not-yet-existing module at base.
const RESIDENCY_CATALOG_SPEC = "../../src/residency/catalog.js" as string;

interface ResidencyCatalogModule {
  buildDeclaredModelEntries?: (input: unknown) => Record<string, unknown>[];
  listDeclaredModels?: (input: unknown) => Record<string, unknown>[];
}

async function residencyCatalog(): Promise<ResidencyCatalogModule> {
  const loaded = (await import(RESIDENCY_CATALOG_SPEC).catch(() => ({}))) as unknown;
  return loaded as ResidencyCatalogModule;
}

type DeclaredModelSource = (() => readonly unknown[]) | null;

const declaredSeam = openaiProxy as unknown as {
  setDeclaredModelSource?: (source: DeclaredModelSource) => void;
};

const declaredEntrySchema = routingCatalog as unknown as {
  DeclaredModelEntryV1Schema?: { safeParse(v: unknown): { success: boolean } };
};

function declaredModelEntry(
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    workload: "wl-declared",
    kind: "ModelRun",
    ownerNodeId: "local",
    state: "cold",
    autoLoadEligible: true,
    ...over,
  };
}

function hostManifest(name: string, spec: Record<string, unknown> = {}): ModelHostManifest {
  return ModelHostManifestSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelHost",
    metadata: { name },
    spec: {
      engine: "omlx",
      node: "local",
      binary: "/x/engine",
      endpoint: { host: "127.0.0.1", port: 8100 },
      hostedModels: [{ rel: "org/repo/m.gguf" }],
      ...spec,
    },
  });
}

function runManifest(name: string, spec: Record<string, unknown> = {}): ModelRun {
  return ModelRunSchema.parse({
    apiVersion: "llamactl/v1",
    kind: "ModelRun",
    metadata: { name },
    spec: {
      node: "local",
      target: { kind: "rel", value: "org/repo/run.gguf" },
      ...spec,
    },
  });
}

const NODE_RUN_YAML = `apiVersion: llamactl/v1
kind: NodeRun
metadata:
  name: node-c
spec:
  node: local
  infra: []
`;

const ENV_KEYS = [
  "DEV_STORAGE",
  "LOCAL_AI_RUNTIME_DIR",
  "LLAMACTL_WORKLOADS_DIR",
  "LLAMACTL_CONFIG",
] as const;

let envBackup: Record<string, string | undefined> = {};

beforeAll(() => {
  envBackup = {};
  for (const key of ENV_KEYS) envBackup[key] = process.env[key];
});

afterEach(() => {
  declaredSeam.setDeclaredModelSource?.(null);
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const prev = envBackup[key];
    if (prev === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = prev;
  }
});

describe("buildDeclaredModelEntries", () => {
  test("an enabled ModelHost declares its rel and basename as cold entries", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-a")],
      modelRuns: [],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toMatchObject([
      {
        id: "m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
      {
        id: "org/repo/m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
    ]);
  });

  test("a disabled ModelHost and ModelRun declare disabled entries", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-off", { enabled: false })],
      modelRuns: [runManifest("run-off", { enabled: false })],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toMatchObject([
      {
        id: "m.gguf",
        workload: "host-off",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "disabled",
        autoLoadEligible: false,
      },
      {
        id: "org/repo/m.gguf",
        workload: "host-off",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "disabled",
        autoLoadEligible: false,
      },
      {
        id: "org/repo/run.gguf",
        workload: "run-off",
        kind: "ModelRun",
        ownerNodeId: "local",
        state: "disabled",
        autoLoadEligible: false,
      },
    ]);
  });

  test("an id in liveModelIds is ready and not auto-load eligible", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-a")],
      modelRuns: [],
      liveModelIds: new Set(["m.gguf"]),
    });

    expect(entries).toMatchObject([
      {
        id: "m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "ready",
        autoLoadEligible: false,
      },
      {
        id: "org/repo/m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
    ]);
  });

  test("a ModelRun declares its rel target and --alias entries", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [],
      modelRuns: [
        runManifest("run-a", {
          target: { kind: "rel", value: "org/repo/run.gguf" },
          extraArgs: ["--alias", "fast-a"],
        }),
      ],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toMatchObject([
      {
        id: "fast-a",
        workload: "run-a",
        kind: "ModelRun",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
      {
        id: "org/repo/run.gguf",
        workload: "run-a",
        kind: "ModelRun",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
    ]);
  });

  test("ModelRuns that cannot declare local ids yield nothing", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [],
      modelRuns: [
        runManifest("run-alias", { target: { kind: "alias", value: "best" } }),
        runManifest("run-gw", { gateway: true }),
        runManifest("run-auto", { node: "auto" }),
        runManifest("run-remote", { node: "gpu1" }),
      ],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toEqual([]);
  });

  test("colliding declarations yield unavailable alias-collision entries", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-a")],
      modelRuns: [runManifest("run-b", { target: { kind: "rel", value: "org/repo/m.gguf" } })],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toMatchObject([
      {
        id: "m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "cold",
        autoLoadEligible: true,
      },
      {
        id: "org/repo/m.gguf",
        workload: "host-a",
        kind: "ModelHost",
        ownerNodeId: "local",
        state: "unavailable",
        autoLoadEligible: false,
        reason: "alias-collision",
      },
      {
        id: "org/repo/m.gguf",
        workload: "run-b",
        kind: "ModelRun",
        ownerNodeId: "local",
        state: "unavailable",
        autoLoadEligible: false,
        reason: "alias-collision",
      },
    ]);
  });

  test("absolute-path ids are dropped", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-ok", { hostedModels: [{ rel: "org/repo/ok.gguf" }] })],
      modelRuns: [
        runManifest("run-abs", { target: { kind: "rel", value: "/abs/secret/model.gguf" } }),
      ],
      liveModelIds: new Set<string>(),
    });

    expect(entries.map((e) => e["id"])).toEqual(["ok.gguf", "org/repo/ok.gguf"]);
    expect(entries.some((e) => String(e["id"]).startsWith("/"))).toBe(false);
  });

  test("ModelHost with an absolute hostedModels[0].rel drops it, keeps relative", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const absHost: ModelHostManifest = {
      apiVersion: "llamactl/v1",
      kind: "ModelHost",
      metadata: { name: "host-abs" },
      spec: {
        engine: "omlx",
        node: "local",
        enabled: true,
        binary: "/x/engine",
        endpoint: { host: "127.0.0.1", port: 8100 },
        hostedModels: [{ rel: "/abs/secret/model.gguf" }, { rel: "org/relative/model.gguf" }],
        extraArgs: [],
        restartPolicy: "Always",
        timeoutSeconds: 60,
      },
    };

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [absHost],
      modelRuns: [],
      liveModelIds: new Set<string>(),
    });

    const declaredModelIds = entries.map((e) => e["id"]);
    expect(declaredModelIds).toEqual(["model.gguf"]);
    expect(declaredModelIds.some((id) => String(id).startsWith("/"))).toBe(false);
  });

  test("entries carry no host, port, binary, env or path keys", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-a")],
      modelRuns: [
        runManifest("run-b", {
          target: { kind: "rel", value: "org/repo/m.gguf" },
          extraArgs: ["--alias", "fast-a"],
        }),
      ],
      liveModelIds: new Set<string>(),
    });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      for (const key of ["host", "port", "binary", "env", "path"]) {
        expect(key in entry).toBe(false);
      }
    }
  });

  test("every entry passes DeclaredModelEntryV1Schema", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-a")],
      modelRuns: [
        runManifest("run-b", {
          target: { kind: "rel", value: "org/repo/m.gguf" },
          extraArgs: ["--alias", "fast-a"],
        }),
      ],
      liveModelIds: new Set<string>(),
    });

    const schema = declaredEntrySchema.DeclaredModelEntryV1Schema;
    expect(schema).toBeDefined();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(schema!.safeParse(entry).success).toBe(true);
    }
  });

  test("a ModelHost pinned to another node yields no claims", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [hostManifest("host-gpu1", { node: "gpu1" })],
      modelRuns: [],
      liveModelIds: new Set<string>(),
    });

    expect(entries).toEqual([]);
  });

  test("output is sorted by id then workload", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.buildDeclaredModelEntries).toBe("function");

    const entries = mod.buildDeclaredModelEntries!({
      nodeName: "local",
      modelHosts: [
        hostManifest("zeta-host", { hostedModels: [{ rel: "org/z.gguf" }] }),
        hostManifest("alpha-host", { hostedModels: [{ rel: "org/a.gguf" }] }),
      ],
      modelRuns: [runManifest("beta-run")],
      liveModelIds: new Set<string>(),
    });

    expect(entries.map((e) => e["id"])).toEqual([
      "a.gguf",
      "org/a.gguf",
      "org/repo/run.gguf",
      "org/z.gguf",
      "z.gguf",
    ]);
  });
});

describe("listDeclaredModels", () => {
  test("reads ModelHost and ModelRun YAML, skipping NodeRun and unparseable files", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.listDeclaredModels).toBe("function");

    const dir = mkdtempSync(join(tmpdir(), "llamactl-declared-catalog-"));
    try {
      writeFileSync(join(dir, "host-a.yaml"), stringifyYaml(hostManifest("host-a")));
      writeFileSync(
        join(dir, "run-b.yaml"),
        stringifyYaml(runManifest("run-b", { extraArgs: ["--alias", "fast-a"] })),
      );
      writeFileSync(join(dir, "node-c.yaml"), NODE_RUN_YAML);
      writeFileSync(join(dir, "broken.yaml"), "kind: ModelRun\nspec: [unterminated\n");

      const entries = mod.listDeclaredModels!({
        dir,
        nodeName: "local",
        liveModelIds: new Set<string>(),
      });

      expect(entries).toMatchObject([
        { id: "fast-a", workload: "run-b", kind: "ModelRun" },
        { id: "m.gguf", workload: "host-a", kind: "ModelHost" },
        { id: "org/repo/m.gguf", workload: "host-a", kind: "ModelHost" },
        { id: "org/repo/run.gguf", workload: "run-b", kind: "ModelRun" },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns [] for a missing dir", async () => {
    const mod = await residencyCatalog();
    expect(typeof mod.listDeclaredModels).toBe("function");

    const dir = mkdtempSync(join(tmpdir(), "llamactl-declared-catalog-"));
    try {
      const entries = mod.listDeclaredModels!({
        dir: join(dir, "does-not-exist"),
        nodeName: "local",
        liveModelIds: new Set<string>(),
      });

      expect(entries).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unified ingress", () => {
  test("a declared cold pin returns 503 model_not_loaded through the unified proxy", async () => {
    const sandbox = mkdtempSync(join(tmpdir(), "llamactl-cold-unified-"));
    const stubCalls: string[] = [];
    const stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req: Request): Response {
        stubCalls.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ ok: true });
      },
    });
    try {
      const runtimeDir = join(sandbox, "runtime");
      mkdirSync(runtimeDir, { recursive: true });
      process.env["DEV_STORAGE"] = join(sandbox, "dev-storage");
      process.env["LOCAL_AI_RUNTIME_DIR"] = runtimeDir;
      process.env["LLAMACTL_WORKLOADS_DIR"] = join(sandbox, "workloads");
      process.env["LLAMACTL_CONFIG"] = join(sandbox, "missing-kubeconfig.yaml");
      const resolved = resolveEnv({
        DEV_STORAGE: join(sandbox, "dev-storage"),
        LOCAL_AI_RUNTIME_DIR: runtimeDir,
        LLAMA_CPP_HOST: "127.0.0.1",
        LLAMA_CPP_PORT: String(stub.port ?? 0),
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "/tmp",
      });
      const proxy = createProxy({ env: { LLAMACTL_UNIFIED_PROXY: "1" }, resolved });
      expect(proxy.unifiedEnabled).toBe(true);
      declaredSeam.setDeclaredModelSource?.(() => [declaredModelEntry("cold/model-a.gguf")]);

      const res = await proxy.handleRequest(
        new Request("http://local/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "cold/model-a.gguf",
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("model_not_loaded");
      expect(stubCalls).toHaveLength(0);
    } finally {
      await stub.stop(true);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
