import type { Server } from "bun";

import { describe, expect, test } from "bun:test";

import type { EngineBootEnv, ModelHostSpecForEngine } from "../../src/engines/types.js";

import { ENGINES } from "../../src/engines/index.js";
import { formatHostForUrl, gracefulShutdown } from "../../src/engines/lifecycle.js";

function endpointOf(server: Server<undefined>): { host: string; port: number } {
  if (server.port === undefined) throw new Error("probe server did not bind a port");
  return { host: "127.0.0.1", port: server.port };
}

const baseSpec: ModelHostSpecForEngine = {
  engine: "llamacpp",
  binary: "/some/path/llama-server",
  endpoint: { host: "127.0.0.1", port: 8090 },
  hostedModels: [{ rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf" }],
  resources: { expectedMemoryGiB: 5 },
  extraArgs: ["--jinja"],
  timeoutSeconds: 60,
};

describe("llamacpp engine adapter", () => {
  test("validateSpec passes a well-formed spec", () => {
    const result = ENGINES.llamacpp.validateSpec(baseSpec);
    expect(result.ok).toBe(true);
  });

  test("validateSpec rejects missing binary", () => {
    const bad = { ...baseSpec, binary: "" };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/binary/i);
  });

  test("validateSpec rejects zero hosted models", () => {
    const bad = { ...baseSpec, hostedModels: [] };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/hostedModels/);
  });

  test("validateSpec rejects non-loopback endpoint host", () => {
    const bad = { ...baseSpec, endpoint: { host: "example.com", port: 8090 } };
    const result = ENGINES.llamacpp.validateSpec(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/loopback|0\.0\.0\.0/);
  });

  test("buildBootCommand includes --port and the hosted model rel", () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: "/tmp/models",
    });
    expect(built.binary).toBe("/some/path/llama-server");
    expect(built.args).toContain("--port");
    expect(built.args).toContain("8090");
    const joined = built.args.join(" ");
    expect(joined).toMatch(/granite-4\.1-3b/);
  });

  test("buildBootCommand appends extraArgs verbatim after engine defaults", () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: "/tmp/models",
    });
    expect(built.args).toContain("--jinja");
    const portIdx = built.args.indexOf("--port");
    const jinjaIdx = built.args.indexOf("--jinja");
    expect(jinjaIdx).toBeGreaterThan(portIdx);
  });

  test("buildBootCommand omits --lora when no lora_path is set", () => {
    const built = ENGINES.llamacpp.buildBootCommand(baseSpec, {
      LLAMA_CPP_MODELS: "/tmp/models",
    });
    expect(built.args).not.toContain("--lora");
  });

  test("buildBootCommand emits --lora with the resolved path after -m when set", () => {
    const spec: ModelHostSpecForEngine = {
      ...baseSpec,
      hostedModels: [
        {
          rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
          lora_path: "adapters/granite-sql-lora.gguf",
        },
      ],
    };
    const built = ENGINES.llamacpp.buildBootCommand(spec, {
      LLAMA_CPP_MODELS: "/tmp/models",
    });
    const loraIdx = built.args.indexOf("--lora");
    expect(loraIdx).toBeGreaterThan(-1);
    expect(built.args[loraIdx + 1]).toBe("/tmp/models/adapters/granite-sql-lora.gguf");
    const modelIdx = built.args.indexOf("-m");
    expect(loraIdx).toBeGreaterThan(modelIdx);
  });

  test("buildBootCommand keeps extraArgs after the --lora pair", () => {
    const spec: ModelHostSpecForEngine = {
      ...baseSpec,
      hostedModels: [
        {
          rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
          lora_path: "adapters/granite-sql-lora.gguf",
        },
      ],
    };
    const built = ENGINES.llamacpp.buildBootCommand(spec, {
      LLAMA_CPP_MODELS: "/tmp/models",
    });
    const loraIdx = built.args.indexOf("--lora");
    const jinjaIdx = built.args.indexOf("--jinja");
    expect(jinjaIdx).toBeGreaterThan(loraIdx);
  });

  test("buildBootCommand rejects lora_path that escapes models dir", () => {
    const bad: ModelHostSpecForEngine = {
      ...baseSpec,
      hostedModels: [
        {
          rel: "granite-4.1-3b-GGUF/granite-4.1-3b-Q8_0.gguf",
          lora_path: "../escape-lora.gguf",
        },
      ],
    };
    expect(() =>
      ENGINES.llamacpp.buildBootCommand(bad, {
        LLAMA_CPP_MODELS: "/tmp/models",
      } satisfies EngineBootEnv),
    ).toThrow(/lora_path escapes models dir/);
  });

  test("buildBootCommand rejects hosted model rel escapes", () => {
    const bad = {
      ...baseSpec,
      hostedModels: [{ rel: "../escape.gguf" }],
    };
    expect(() =>
      ENGINES.llamacpp.buildBootCommand(bad, {
        LLAMA_CPP_MODELS: "/tmp/models",
      } satisfies EngineBootEnv),
    ).toThrow(/escapes models dir/);
  });

  test("probeReady resolves only when /v1/models advertises a model id", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ object: "list", data: [{ id: "granite-4.1-3b-Q8_0.gguf" }] }),
          {
            headers: { "content-type": "application/json" },
          },
        ),
      )) as unknown as typeof fetch;
    const result = await ENGINES.llamacpp.probeReady({ host: "127.0.0.1", port: 12345 }, 1000);
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(true);
    expect(result.modelIds).toContain("granite-4.1-3b-Q8_0.gguf");
  });

  test("probeReady waits for the readiness probe even when /v1/models already lists a model", async () => {
    let serveReady = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "gufo-qwen38-mtp" }] });
        }
        if (path === "/ready") {
          return serveReady
            ? Response.json({ status: "ready", model: "gufo-qwen38-mtp" })
            : new Response("loading", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const endpoint = endpointOf(server);
    try {
      const notReady = await ENGINES.llamacpp.probeReady(endpoint, 400, {
        path: "/ready",
        expectStatus: 200,
        expectJson: { status: "ready" },
      });
      expect(notReady.ready).toBe(false);
      serveReady = true;
      const ready = await ENGINES.llamacpp.probeReady(endpoint, 2000, {
        path: "/ready",
        expectStatus: 200,
        expectJson: { status: "ready" },
      });
      expect(ready.ready).toBe(true);
      expect(ready.modelIds).toContain("gufo-qwen38-mtp");
    } finally {
      await server.stop();
    }
  });

  test("probeReady stays not ready while the readiness body mismatches expectJson", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "gufo-qwen38-mtp" }] });
        }
        if (path === "/ready") {
          return Response.json({ status: "warming", model: "gufo-qwen38-mtp" });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const endpoint = endpointOf(server);
    try {
      const mismatch = await ENGINES.llamacpp.probeReady(endpoint, 400, {
        path: "/ready",
        expectJson: { status: "ready" },
      });
      expect(mismatch.ready).toBe(false);
      const matched = await ENGINES.llamacpp.probeReady(endpoint, 2000, {
        path: "/ready",
        expectJson: { status: "warming" },
      });
      expect(matched.ready).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test("probeReady without readiness ignores the probe endpoint entirely", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/v1/models") {
          return Response.json({ object: "list", data: [{ id: "gufo-qwen38-mtp" }] });
        }
        return new Response("loading", { status: 503 });
      },
    });
    try {
      const result = await ENGINES.llamacpp.probeReady(endpointOf(server), 2000);
      expect(result.ready).toBe(true);
      expect(result.modelIds).toContain("gufo-qwen38-mtp");
    } finally {
      await server.stop();
    }
  });

  test("formatHostForUrl brackets IPv6 literals", () => {
    expect(formatHostForUrl("::1")).toBe("[::1]");
    expect(formatHostForUrl("127.0.0.1")).toBe("127.0.0.1");
  });

  test("probeReady returns ready:false without overrunning timeout", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: Request | URL | string, init?: RequestInit) =>
      await new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    const started = Date.now();
    const result = await ENGINES.llamacpp.probeReady({ host: "127.0.0.1", port: 12345 }, 300);
    const elapsed = Date.now() - started;
    globalThis.fetch = originalFetch;
    expect(result.ready).toBe(false);
    expect(elapsed).toBeLessThan(1200);
  });

  test("teardown returns quickly when the process exits on its own", async () => {
    const proc = Bun.spawn(["sh", "-lc", "sleep 0.2"], { stderr: "pipe", stdout: "pipe" });
    const started = Date.now();
    await ENGINES.llamacpp.teardown(proc.pid);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });

  test("teardown escalates to SIGKILL after grace expires", async () => {
    const proc = Bun.spawn(
      [
        "python3",
        "-c",
        "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)",
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const started = Date.now();
    await gracefulShutdown(proc.pid, 250);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
    expect(() => process.kill(proc.pid, 0)).toThrow();
  });
});
