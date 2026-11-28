import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { LocalRoute, PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { QUALIFICATION_LABEL } from "../src/routing/capabilities.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import * as workloadRuntime from "../src/workloadRuntime.js";

// #518: ModelInfo and DeclaredModelInfo have no `degraded` field at the base
// revision, so these widened views keep the RED cases typechecking while the
// missing flag fails by assertion.
interface FlaggedEntry {
  id: string;
  experimental?: true;
  degraded?: true;
}

const originalFetch = globalThis.fetch;
const savedQualificationOverridesFile = process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
let restoreWarn: (() => void) | undefined;

beforeEach(() => {
  delete process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
  const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
  restoreWarn = (): void => {
    warnSpy.mockRestore();
  };
});

afterEach(() => {
  restoreWarn?.();
  restoreWarn = undefined;
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
  openaiProxy.setDeclaredModelSource(null);
  if (savedQualificationOverridesFile === undefined) {
    delete process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
  } else {
    process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"] = savedQualificationOverridesFile;
  }
});

function tempEnv(extra?: Record<string, string>): {
  env: ResolvedEnv;
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-models-degraded-"));
  return {
    env: resolveEnv({
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: dir,
      LLAMA_CPP_MODELS: join(dir, "models"),
      ...extra,
    }),
    dir,
    cleanup: (): void => {
      rmSync(dir, { recursive: true, force: true });
    },
  } satisfies { env: ResolvedEnv; dir: string; cleanup: () => void };
}

function writeLlamaServerWorkload(
  runtimeRoot: string,
  workload: string,
  state: { rel: string; port: number; extraArgs?: string[] },
): void {
  const dir = join(runtimeRoot, "workloads", workload);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server.pid"), `${String(process.pid)}\n`);
  writeFileSync(
    join(dir, "llama-server.state"),
    JSON.stringify({
      rel: state.rel,
      extraArgs: state.extraArgs ?? [],
      host: "127.0.0.1",
      port: state.port,
      binary: "/x/llama-server",
      pid: process.pid,
      startedAt: "2026-05-24T00:00:00.000Z",
      tunedProfile: null,
    }),
  );
}

function writeCatalog(dir: string): void {
  writeFileSync(
    join(dir, "curated-models.tsv"),
    'deg-model\tDeg\tdeg\tcustom\tcustom\tdeg/model.gguf\torg/deg\tgguf\t{"qualification":{"stage":"degraded"}}\n',
  );
}

function writeDegradedCollisionFixture(dir: string): void {
  writeCatalog(dir);
  writeLlamaServerWorkload(dir, "a-deg", {
    rel: "deg/model.gguf",
    port: 8361,
    extraArgs: ["--alias", "shared-alias"],
  });
  writeLlamaServerWorkload(dir, "b-prod", {
    rel: "prod/model.gguf",
    port: 8362,
    extraArgs: ["--alias", "shared-alias"],
  });
}

function writePin(runtimeDir: string, rel: string, stage: string): void {
  writeFileSync(
    join(runtimeDir, "qualification-overrides.tsv"),
    `${rel}\tpin\t${stage}\tops\twhy\t2026-11-27T00:00:00Z\n`,
  );
}

function peerSnapshot(labels?: Record<string, string>): PeerSnapshot {
  return {
    workloads: [
      {
        modelId: "org/glm.gguf",
        port: 8080,
        ...(labels !== undefined ? { labels } : {}),
      },
    ],
    pressure: "NORMAL",
    fetchedAt: Date.now(),
  };
}

function declaredSourceEntry(id: string): Record<string, unknown> {
  return {
    id,
    workload: "wl-declared",
    kind: "ModelHost",
    ownerNodeId: "local",
    state: "cold",
    autoLoadEligible: true,
  };
}

const dataEntries = (models: unknown): FlaggedEntry[] => (models as { data: FlaggedEntry[] }).data;

const declaredEntries = (models: unknown): FlaggedEntry[] =>
  (models as { declared: FlaggedEntry[] }).declared;

describe("/v1/models degraded flag (#518)", () => {
  test("M1: a degraded local winner is flagged without becoming experimental", () => {
    const t = tempEnv();
    try {
      writeDegradedCollisionFixture(t.dir);

      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "deg/model.gguf",
      );

      expect(entry?.degraded).toBe(true);
      expect("experimental" in (entry ?? {})).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("M2: a pin row turns an otherwise unstaged live rel degraded", () => {
    const t = tempEnv();
    try {
      writePin(t.dir, "prod/model.gguf", "degraded");
      writeLlamaServerWorkload(t.dir, "b-prod", { rel: "prod/model.gguf", port: 8363 });

      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "prod/model.gguf",
      );

      expect(entry?.degraded).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("M3: a peer-only id whose only peer route is degraded is flagged", () => {
    const t = tempEnv();
    try {
      openaiProxy.__setOpenAIProxyClusterRoutingForTests({
        clusterPeers: [{ id: "peer-a", endpoint: "https://127.0.0.1:7843" }],
        peerSnapshots: new Map<string, PeerSnapshot>([
          ["peer-a", peerSnapshot({ [QUALIFICATION_LABEL]: "degraded" })],
        ]),
      });

      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "org/glm.gguf",
      );

      expect(entry?.degraded).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("M4: a declared entry whose routing stage is degraded is flagged", () => {
    const t = tempEnv();
    try {
      openaiProxy.setDeclaredModelSource(() => [declaredSourceEntry("decl/deg.gguf")]);
      writePin(t.dir, "decl/deg.gguf", "degraded");

      const entry = declaredEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "decl/deg.gguf",
      );

      expect(entry?.degraded).toBe(true);
    } finally {
      t.cleanup();
    }
  });

  test("G1: healthy collision winners and unstaged live rels carry no degraded key", () => {
    const t = tempEnv();
    try {
      writeDegradedCollisionFixture(t.dir);

      const entries = dataEntries(openaiProxy.listOpenAIModels(t.env));
      const shared = entries.find((e) => e.id === "shared-alias");
      const prod = entries.find((e) => e.id === "prod/model.gguf");

      expect(shared).toBeDefined();
      expect(prod).toBeDefined();
      expect("degraded" in shared!).toBe(false);
      expect("degraded" in prod!).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("G2: an explicit experimental label wins over a degraded stage", () => {
    const t = tempEnv();
    const route: LocalRoute = {
      workload: "a-exp-deg",
      model: "x/both.gguf",
      host: "127.0.0.1",
      port: 8391,
      engine: "llamacpp",
      kind: "ModelRun",
      pid: process.pid,
      qualificationStage: "degraded",
      labels: { [QUALIFICATION_LABEL]: "experimental" },
    };
    const routesSpy = spyOn(workloadRuntime, "listLocalRoutes").mockImplementation(() => [route]);
    try {
      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "x/both.gguf",
      );

      expect(entry?.experimental).toBe(true);
      expect("degraded" in (entry ?? {})).toBe(false);
    } finally {
      routesSpy.mockRestore();
      t.cleanup();
    }
  });

  test("G3: a healthy peer winner carries no degraded key", () => {
    const t = tempEnv();
    try {
      openaiProxy.__setOpenAIProxyClusterRoutingForTests({
        clusterPeers: [
          { id: "peer-a", endpoint: "https://127.0.0.1:7843" },
          { id: "peer-b", endpoint: "https://127.0.0.1:7844" },
        ],
        peerSnapshots: new Map<string, PeerSnapshot>([
          ["peer-a", peerSnapshot({ [QUALIFICATION_LABEL]: "degraded" })],
          ["peer-b", peerSnapshot()],
        ]),
      });

      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "org/glm.gguf",
      );

      expect(entry).toBeDefined();
      expect("degraded" in entry!).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("G4: an unstaged live rel has neither qualification flag", () => {
    const t = tempEnv();
    try {
      writeLlamaServerWorkload(t.dir, "b-prod", { rel: "prod/model.gguf", port: 8364 });

      const entry = dataEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "prod/model.gguf",
      );

      expect(entry).toBeDefined();
      expect("experimental" in entry!).toBe(false);
      expect("degraded" in entry!).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test("G5: a declared entry pinned experimental is not also degraded", () => {
    const t = tempEnv();
    try {
      openaiProxy.setDeclaredModelSource(() => [declaredSourceEntry("decl/exp.gguf")]);
      writePin(t.dir, "decl/exp.gguf", "experimental");

      const entry = declaredEntries(openaiProxy.listOpenAIModels(t.env)).find(
        (e) => e.id === "decl/exp.gguf",
      );

      expect(entry?.experimental).toBe(true);
      expect("degraded" in (entry ?? {})).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});
