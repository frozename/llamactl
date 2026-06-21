import { saveConfig, upsertNode } from "@llamactl/core/config/kubeconfig";
import { freshConfig } from "@llamactl/core/config/schema";
/**
 * Regression tests for Bug 2 (HIGH):
 *
 * workloadDescribe and workloadDelete query serverStatus on each node
 * with NO per-node timeout. A black-holed or slow node hangs the whole
 * call indefinitely. The fix adds queryServerStatusWithTimeout around
 * both serverStatus queries so the procedure completes with a timeout
 * error instead of hanging.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { router } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { parseWorkload, saveWorkload } from "../src/workload/store.js";

const WORKLOAD_YAML = `
apiVersion: llamactl/v1
kind: ModelRun
metadata:
  name: test-wl
spec:
  node: hang-node
  target:
    kind: rel
    value: test.gguf
`;

/** Deadline long enough that the procedure's internal timeout (5 s) fires
 *  first when the fix is in place. Without the fix the procedure hangs and
 *  this deadline fires instead — making the test fail. */
const RACE_DEADLINE_MS = 6_500;

let tmp = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "llamactl-wl-deadline-"));
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    DEV_STORAGE: tmp,
    LLAMACTL_WORKLOADS_DIR: tmp,
    LLAMACTL_CONFIG: join(tmp, "config"),
  });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Returns a Bun HTTP server that accepts connections but never sends a
 * response, simulating a black-holed / slow agent. The caller must call
 * server.stop(true) in a finally block.
 */
function makeHangingServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      // Never resolves — simulates a node that accepts TCP but does not
      // respond to HTTP (black-holed / very slow upstream).
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return new Promise<Response>((): void => {});
    },
  });
}

function setupHangingNode(port: number): void {
  let cfg = freshConfig();
  cfg = upsertNode(cfg, "home", {
    name: "hang-node",
    endpoint: `http://127.0.0.1:${String(port)}`,
    kind: "agent",
  });
  saveConfig(cfg, join(tmp, "config"));
  saveWorkload(parseWorkload(WORKLOAD_YAML), tmp);
}

// ===========================================================================
// Bug 2 — workloadDescribe
// ===========================================================================
describe("Bug 2 — workloadDescribe per-node deadline", () => {
  test("returns within deadline when coordinator node never responds", async () => {
    const server = makeHangingServer();
    try {
      setupHangingNode(server.port!);
      const caller = router.createCaller({});

      const result = await Promise.race([
        caller.workloadDescribe({ name: "test-wl" }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("procedure hung past deadline"));
          }, RACE_DEADLINE_MS);
        }),
      ]);

      // With the fix the procedure completes and liveStatus holds the
      // timeout error; without it the race timeout fires → test fails.
      expect(result.liveStatus).toMatchObject({
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        error: expect.stringContaining("timed out"),
      });
    } finally {
      await server.stop(true);
    }
  }, 10_000);
});

// ===========================================================================
// Bug 2 — workloadDelete
// ===========================================================================
describe("Bug 2 — workloadDelete per-node deadline", () => {
  test("completes within deadline when coordinator node never responds", async () => {
    const server = makeHangingServer();
    try {
      setupHangingNode(server.port!);
      const caller = router.createCaller({});

      const result = await Promise.race([
        caller.workloadDelete({ name: "test-wl" }),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("procedure hung past deadline"));
          }, RACE_DEADLINE_MS);
        }),
      ]);

      // The coordinator's stop is skipped (timeout) but the manifest is
      // still removed from disk.
      expect(result.ok).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      expect(result.stops).toEqual(expect.arrayContaining([expect.stringContaining("timed out")]));
    } finally {
      await server.stop(true);
    }
  }, 10_000);
});
