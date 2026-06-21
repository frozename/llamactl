import { env as envMod, serverLogs as serverLogsMod } from "@llamactl/core";
import { upsertNode as upsertNodeInConfig } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createNodeClient } from "../src/client/node-client.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

describe("createNodeClient (local sentinel path)", () => {
  test("local node dispatches in-process via router.createCaller", async () => {
    const cfg = freshConfig();
    const client = createNodeClient(cfg);
    const env = await client.env.query();
    expect(env).toBeDefined();
    expect(typeof env.LOCAL_AI_RUNTIME_DIR).toBe("string");
  });

  test("explicit --node local is equivalent to default", async () => {
    const cfg = freshConfig();
    const client = createNodeClient(cfg, { nodeName: "local" });
    expect(await client.env.query()).toBeDefined();
  });

  test("unknown nodeName throws", () => {
    const cfg = freshConfig();
    expect(() => createNodeClient(cfg, { nodeName: "does-not-exist" })).toThrow(/not found/);
  });

  test("resolves remote node definitions without opening a connection yet", () => {
    let cfg = freshConfig();
    cfg = upsertNodeInConfig(cfg, "home", {
      name: "gpu1",
      endpoint: "https://gpu1.lan:7843",
      certificate: "-----BEGIN CERTIFICATE-----\nMIIBtest\n-----END CERTIFICATE-----\n",
    });
    // Client construction for a remote node must not throw just because
    // the host is unreachable — we only connect on first call.
    const client = createNodeClient(cfg, { nodeName: "gpu1" });
    expect(client).toBeDefined();
  });

  test("local subscribe bridges AsyncGenerator events into handlers", async () => {
    const prevRuntimeDir = process.env.LOCAL_AI_RUNTIME_DIR;
    const profile = mkdtempSync(join(tmpdir(), "llamactl-node-client-sub-"));
    process.env.LOCAL_AI_RUNTIME_DIR = join(profile, "runtime");

    try {
      const workload = `sub-bridge-${Date.now().toString(36)}`;
      const logFile = serverLogsMod.serverLogFile(envMod.resolveEnv(), { name: workload });
      mkdirSync(dirname(logFile), { recursive: true });
      writeFileSync(logFile, "line-a\nline-b\n", "utf8");

      const client = createNodeClient(freshConfig());
      const got: string[] = [];
      let started = false;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("serverLogs subscription timed out"));
        }, 2000);
        client.serverLogs.subscribe(
          { workload, lines: 10, follow: false },
          {
            onStarted: () => {
              started = true;
            },
            onData: (evt: unknown) => {
              const e = evt as { type?: string; line?: string };
              if (e.type === "line" && typeof e.line === "string") got.push(e.line);
            },
            onError: (err: unknown) => {
              clearTimeout(timer);
              reject(err instanceof Error ? err : new Error(String(err)));
            },
            onComplete: () => {
              clearTimeout(timer);
              resolve();
            },
          },
        );
      });

      expect(started).toBe(true);
      expect(got).toEqual(["line-a", "line-b"]);
    } finally {
      if (prevRuntimeDir === undefined) delete process.env.LOCAL_AI_RUNTIME_DIR;
      else process.env.LOCAL_AI_RUNTIME_DIR = prevRuntimeDir;
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
