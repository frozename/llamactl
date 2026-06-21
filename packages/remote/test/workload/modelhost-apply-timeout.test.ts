import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { applyManifest, type WorkloadClient } from "../../src/workload/apply.js";

describe("applyManifest — ModelHost timeout cleanup", () => {
  test("unsubscribes the modelHostStart subscription when apply times out", async () => {
    let unsubscribed = false;
    const client: WorkloadClient = {
      serverStatus: {
        query: () =>
          Promise.resolve({
            state: "down",
            rel: null,
            extraArgs: [],
            pid: null,
            host: null,
            port: null,
            binary: null,
            endpoint: "",
          }),
      },
      serverStop: { mutate: () => Promise.resolve({ ok: true }) },
      serverStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
      modelHostStart: {
        subscribe: () => ({
          unsubscribe: (): void => {
            unsubscribed = true;
          },
        }),
      },
      modelHostStop: { mutate: () => Promise.resolve({ ok: true }) },
      modelHostStatus: { query: () => Promise.resolve({ state: "Running" }) },
      rpcServerStart: { subscribe: () => ({ unsubscribe: () => undefined }) },
      rpcServerStop: { mutate: () => Promise.resolve({ ok: true }) },
      rpcServerDoctor: {
        query: () => Promise.resolve({ ok: true, path: null, llamaCppBin: null }),
      },
    };

    const tmp = mkdtempSync(join(tmpdir(), "llamactl-timeout-test-"));
    let result;
    try {
      result = await applyManifest({
        manifest: {
          apiVersion: "llamactl/v1",
          kind: "ModelHost",
          metadata: { name: "mlx-host-timeout" },
          spec: {
            engine: "omlx",
            node: "local",
            enabled: true,
            binary: "/usr/bin/true",
            endpoint: { host: "127.0.0.1", port: 18095 },
            hostedModels: [{ rel: "mlx-community/Test-MLX-4bit" }],
            extraArgs: [],
            restartPolicy: "Always",
            timeoutSeconds: 1,
          },
        },
        getClient: () => client,
        workloadsDir: tmp,
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("timed out");
    expect(unsubscribed).toBe(true);
  });
});
