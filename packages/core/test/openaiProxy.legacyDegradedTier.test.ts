import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedEnv } from "../src/types.js";
import type { PeerSnapshot } from "../src/workloadRuntime.js";

import { resolveEnv } from "../src/env.js";
import { openaiProxy } from "../src/index.js";
import { QUALIFICATION_LABEL } from "../src/routing/capabilities.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { installConditionalChatUpstream } from "./conditionalUpstream.js";

const originalFetch = globalThis.fetch;
const savedQualificationOverridesFile = process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];

beforeEach(() => {
  delete process.env["LOCAL_AI_QUALIFICATION_OVERRIDES_FILE"];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  openaiProxy.__resetOpenAIProxyRouteMapCacheForTests();
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
  const dir = mkdtempSync(join(tmpdir(), "llamactl-legacy-degraded-"));
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

function writeCatalog(dir: string, opts: { experimental?: boolean } = {}): void {
  const rows = [
    'deg-model\tDeg\tdeg\tcustom\tcustom\tdeg/model.gguf\torg/deg\tgguf\t{"qualification":{"stage":"degraded"}}',
  ];
  if (opts.experimental === true) {
    rows.push(
      'exp-model\tExp\texp\tcustom\tcustom\texp/model.gguf\torg/exp\tgguf\t{"qualification":{"stage":"experimental"}}',
    );
  }
  writeFileSync(join(dir, "curated-models.tsv"), `${rows.join("\n")}\n`);
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

const chatRequest = (model: string): Request =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "hi" }],
    }),
  });

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

describe("#518 legacy degraded tier in the proxy", () => {
  test("LD1: a degraded local route loses an alias collision in chat routing", async () => {
    const t = tempEnv();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeDegradedCollisionFixture(t.dir);
      const upstream = installConditionalChatUpstream();

      const res = await openaiProxy.proxyOpenAI(chatRequest("shared-alias"), t.env);

      expect(res.status).toBe(200);
      const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8362/v1/chat/completions");
      expect(warnSpy).toHaveBeenCalledWith(
        "[openaiProxy] route-map collision on model='shared-alias': keeping ModelRun:b-prod, ignoring ModelRun:a-deg",
      );
    } finally {
      warnSpy.mockRestore();
      t.cleanup();
    }
  });

  test("LD2: a degraded local route loses an alias collision in the models listing", () => {
    const t = tempEnv();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeDegradedCollisionFixture(t.dir);

      openaiProxy.listOpenAIModels(t.env);

      expect(warnSpy).toHaveBeenCalledWith(
        "[openaiProxy] route-map collision on model='shared-alias': keeping ModelRun:b-prod, ignoring ModelRun:a-deg",
      );
    } finally {
      warnSpy.mockRestore();
      t.cleanup();
    }
  });

  test("LD3: a healthy peer route leads a degraded peer route in chat routing", async () => {
    const t = tempEnv();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
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
      const calls: string[] = [];
      globalThis.fetch = ((input: Request | URL | string) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        calls.push(url);
        return Promise.resolve(Response.json({ ok: true }));
      }) as unknown as typeof fetch;

      const res = await openaiProxy.proxyOpenAI(chatRequest("org/glm.gguf"), t.env);

      expect(res.status).toBe(200);
      expect(calls).toEqual(["https://127.0.0.1:7844/v1/chat/completions"]);
    } finally {
      warnSpy.mockRestore();
      t.cleanup();
    }
  });

  test("LD4: an experimental route still sorts behind a degraded route", async () => {
    const t = tempEnv();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      writeCatalog(t.dir, { experimental: true });
      writeLlamaServerWorkload(t.dir, "a-exp", {
        rel: "exp/model.gguf",
        port: 8371,
        extraArgs: ["--alias", "shared-alias"],
      });
      writeLlamaServerWorkload(t.dir, "b-deg", {
        rel: "deg/model.gguf",
        port: 8372,
        extraArgs: ["--alias", "shared-alias"],
      });
      const upstream = installConditionalChatUpstream();

      const res = await openaiProxy.proxyOpenAI(chatRequest("shared-alias"), t.env);

      expect(res.status).toBe(200);
      const chatCalls = upstream.calls.filter((c) => c.url.endsWith("/v1/chat/completions"));
      expect(chatCalls).toHaveLength(1);
      expect(chatCalls[0]!.url).toBe("http://127.0.0.1:8372/v1/chat/completions");
    } finally {
      warnSpy.mockRestore();
      t.cleanup();
    }
  });
});
