import type { NodeClient } from "@llamactl/remote";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runComposite } from "../src/commands/composite.js";
import { runInit } from "../src/commands/init.js";
import {
  __resetWorkloadTestSeams,
  __setWorkloadTestSeams,
  runApply,
  runGet,
} from "../src/commands/workload.js";

/**
 * Opt-in E2E covering the full onboarding round-trip:
 *   `llamactl init --apply → composite list → composite destroy`
 *
 * Gate: `LLAMACTL_INIT_E2E=1`. Hits the real Docker daemon through
 * the router's in-proc caller — the CLI tests we run in CI skip this
 * entirely; developers opt in locally to confirm the onboarding path
 * still works end-to-end after runtime-backend refactors.
 *
 * Why opt-in: the test pulls the `chromadb/chroma` image (can be slow
 * on a cold machine), binds port 18002, and leaves no residue on
 * failure beyond whatever the composite-destroy cleanup missed.
 */

const SHOULD_RUN = process.env.LLAMACTL_INIT_E2E === "1";

let tmp = "";
let compositesDir = "";
let configPath = "";
const originalEnv = { ...process.env };
let dockerReachable = false;

type MockServerStatus = {
  state: string;
  rel: null;
  extraArgs: never[];
  pid: null;
  host: null;
  port: null;
  binary: null;
  endpoint: string;
};

type MockSubscription = { unsubscribe(): void };

type MockModelHostClient = {
  serverStatus: { query: () => Promise<MockServerStatus> };
  serverStop: { mutate: () => Promise<{ ok: boolean }> };
  serverStart: { subscribe: () => Promise<MockSubscription> };
  modelHostStart: {
    subscribe: (
      _input: unknown,
      callbacks: { onData: (data: unknown) => void; onComplete: () => void },
    ) => Promise<MockSubscription>;
  };
  modelHostStop: { mutate: () => Promise<{ ok: boolean }> };
  modelHostStatus: { query: () => Promise<{ state: string; pid: number }> };
  rpcServerStart: { subscribe: () => Promise<MockSubscription> };
  rpcServerStop: { mutate: () => Promise<{ ok: boolean }> };
  rpcServerDoctor: { query: () => Promise<{ ok: boolean; path: null; llamaCppBin: null }> };
};

function makeModelHostClient(): MockModelHostClient {
  return {
    serverStatus: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      query: async (): Promise<MockServerStatus> => ({
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
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    serverStop: { mutate: async (): Promise<{ ok: boolean }> => ({ ok: true }) },
    serverStart: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      subscribe: async (): Promise<MockSubscription> => ({
        unsubscribe(): void {
          return;
        },
      }),
    },
    modelHostStart: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      subscribe: async (
        _input: unknown,
        callbacks: { onData: (data: unknown) => void; onComplete: () => void },
      ): Promise<MockSubscription> => {
        queueMicrotask(() => {
          callbacks.onData({
            type: "done",
            result: { ok: true, pid: 3333, endpoint: "http://127.0.0.1:8094" },
          });
          callbacks.onComplete();
        });
        return {
          unsubscribe(): void {
            return;
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    modelHostStop: { mutate: async (): Promise<{ ok: boolean }> => ({ ok: true }) },
    modelHostStatus: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      query: async (): Promise<{ state: string; pid: number }> => ({ state: "Running", pid: 3333 }),
    },
    rpcServerStart: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      subscribe: async (): Promise<MockSubscription> => ({
        unsubscribe(): void {
          return;
        },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
    rpcServerStop: { mutate: async (): Promise<{ ok: boolean }> => ({ ok: true }) },
    rpcServerDoctor: {
      // eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
      query: async (): Promise<{ ok: boolean; path: null; llamaCppBin: null }> => ({
        ok: true,
        path: null,
        llamaCppBin: null,
      }),
    },
  };
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  tmp = mkdtempSync(join(tmpdir(), "llamactl-init-e2e-"));
  compositesDir = join(tmp, "composites");
  configPath = join(tmp, "config");
  process.env.LLAMACTL_COMPOSITES_DIR = compositesDir;
  process.env.LLAMACTL_CONFIG = configPath;
  __setWorkloadTestSeams({
    getNodeClientByName: () => makeModelHostClient() as unknown as NodeClient,
  });

  try {
    // Cheap docker-reachability probe without pulling the full
    // backend graph into the test harness.
    const { createDockerBackend } = await import("@llamactl/remote");
    const backend = createDockerBackend();
    await backend.ping();
    dockerReachable = true;
  } catch {
    dockerReachable = false;
  }
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  __resetWorkloadTestSeams();
});

function silence<T>(fn: () => Promise<T>): Promise<T> {
  const stdoutOrig = process.stdout.write.bind(process.stdout);
  const stderrOrig = process.stderr.write.bind(process.stderr);

  process.stdout.write = (_s: string | Uint8Array): boolean => true;

  process.stderr.write = (_s: string | Uint8Array): boolean => true;
  return fn().finally(() => {
    process.stdout.write = stdoutOrig;

    process.stderr.write = stderrOrig;
  });
}

describe.skipIf(!SHOULD_RUN)("init → apply → destroy round-trip", () => {
  test(
    "chroma-only template writes, applies, lists, destroys",
    async () => {
      if (!dockerReachable) {
        console.warn("[init-e2e] skipping: docker daemon unreachable");
        return;
      }

      // 1. Init — write the manifest.
      const initRc = await silence(() =>
        runInit([
          "--yes",
          "--no-apply",
          "--runtime=docker",
          "--template=chroma-only",
          "--name=init-e2e",
        ]),
      );
      expect(initRc).toBe(0);
      const manifestPath = join(compositesDir, "init-e2e.yaml");
      const yaml = readFileSync(manifestPath, "utf8");
      expect(yaml).toContain("name: init-e2e");
      expect(yaml).toContain("runtime: docker");

      // 2. Apply via the composite subcommand so we exercise the same
      //    path an operator would take.
      const applyRc = await silence(() => runComposite(["apply", "-f", manifestPath]));
      expect(applyRc).toBe(0);

      // 3. List — composite should be present.
      let listed = "";
      const stdoutOrig = process.stdout.write.bind(process.stdout);

      process.stdout.write = (s: string | Uint8Array): boolean => {
        listed += typeof s === "string" ? s : String(s);
        return true;
      };
      try {
        const listRc = await runComposite(["list"]);
        expect(listRc).toBe(0);
      } finally {
        process.stdout.write = stdoutOrig;
      }
      expect(listed).toContain("init-e2e");

      // 4. Destroy — cleans up.
      const destroyRc = await silence(() => runComposite(["destroy", "init-e2e"]));
      expect(destroyRc).toBe(0);
    },
    10 * 60_000,
  );
});

describe.skipIf(!SHOULD_RUN)("modelhost workload round-trip", () => {
  test(
    "apply persists ModelHost and list renders it",
    async () => {
      const workloadDir = join(tmp, "workloads");
      process.env.LLAMACTL_WORKLOADS_DIR = workloadDir;
      process.env.LOCAL_AI_RUNTIME_DIR = join(tmp, "runtime");
      const fakeBinary = join(tmp, "omlx");
      await Bun.write(fakeBinary, "");

      const manifestPath = join(tmp, "mlx-host-local.yaml");
      await Bun.write(
        manifestPath,
        [
          "apiVersion: llamactl/v1",
          "kind: ModelHost",
          "metadata:",
          "  name: mlx-host-local",
          "spec:",
          "  enabled: true",
          "  node: local",
          "  engine: omlx",
          `  binary: ${fakeBinary}`,
          "  endpoint:",
          "    host: 127.0.0.1",
          "    port: 8094",
          "  hostedModels:",
          "    - rel: mlx-community/Qwen3-8B-MLX-4bit",
          "  resources:",
          "    expectedMemoryGiB: 12",
          "  extraArgs: []",
          "  timeoutSeconds: 60",
          "",
        ].join("\n"),
      );

      let stdout = "";
      const stdoutOrig = process.stdout.write.bind(process.stdout);

      process.stdout.write = (s: string | Uint8Array): boolean => {
        stdout += typeof s === "string" ? s : String(s);
        return true;
      };

      try {
        const applyRc = await runApply(["-f", manifestPath]);
        expect(applyRc).toBe(0);
        const listRc = await runGet(["workloads"]);
        expect(listRc).toBe(0);
      } finally {
        process.stdout.write = stdoutOrig;
      }

      expect(stdout).toContain("modelhost/mlx-host-local");
      expect(stdout).toContain("ModelHost ready at http://127.0.0.1:8094");
    },
    10 * 60_000,
  );
});
