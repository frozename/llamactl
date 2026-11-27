import { rpcServer, server } from "@llamactl/core";
import { resolveEnv } from "@llamactl/core/env";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDirectResidencyStart } from "../../src/residency/direct-lifecycle.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "../../src/safe-fs.js";
import { startModelHost, stopModelHost } from "../../src/server/modelhost.js";
import { type RunningAgent, startAgentServer } from "../../src/server/serve.js";
import { startManagedAgentServer } from "../../src/server/start-managed-agent.js";
import { parseNodeRun, saveNodeRun } from "../../src/workload/noderun-store.js";

test("an owner marker blocks unmanaged engine lifecycle on the same runtime root", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-owner-"));
  const runtimeDir = join(dir, "runtime");
  const env = { LOCAL_AI_RUNTIME_DIR: runtimeDir, DEV_STORAGE: dir };
  const resolved = resolveEnv(env);
  const key = { name: "fixture" };
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "managed-residency-v1"), "fixture-node\n");

  try {
    expect(await server.startServer({ key, target: "absent", resolved, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await server.stopServer({ key, resolved })).toMatchObject({ stopped: false });
    expect(await startModelHost({ key, runtimeDir, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await stopModelHost({ key, runtimeDir, env })).toMatchObject({
      ok: false,
      error: "ManagedOwnerRequired",
    });
    expect(await rpcServer.startRpcServer({ port: 0, resolved, env })).toMatchObject({
      ok: false,
      error: "ManagedRpcServerUnavailable",
    });
    expect(await rpcServer.stopRpcServer({ resolved })).toMatchObject({ stopped: false });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
  "agent activation requires a local budget and retains ownership across a clean restart",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-agent-"));
    const runtimeDir = join(dir, "runtime");
    const workloadsDir = join(dir, "workloads");
    const env = {
      DEV_STORAGE: dir,
      LOCAL_AI_RUNTIME_DIR: runtimeDir,
      LLAMACTL_WORKLOADS_DIR: workloadsDir,
      LLAMACTL_RESIDENCY_STORE: join(dir, "operations.sqlite"),
    };
    const previous = Object.keys(env).map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, env);
    const bearer = "managed-agent-fixture";
    const opts = {
      bindHost: "127.0.0.1",
      port: 0,
      tokenHash: createHash("sha256").update(bearer).digest("hex"),
    };
    const name = "managed-fixture";
    let running: RunningAgent | undefined;
    try {
      const unknown = await startManagedAgentServer(opts, name).catch((error: unknown) => error);
      expect(unknown).toEqual(new Error("BudgetUnknown"));
      expect(existsSync(join(runtimeDir, "managed-residency-v1"))).toBe(false);
      saveNodeRun(
        parseNodeRun(`
apiVersion: llamactl/v1
kind: NodeRun
metadata: { name: ${name} }
spec:
  node: ${name}
  budget: { memoryGiB: 24 }
`),
        workloadsDir,
      );
      running = await startManagedAgentServer(opts, name);
      const double = await startManagedAgentServer(opts, name).catch((error: unknown) => error);
      expect(double).toEqual(new Error("ManagedAgentAlreadyActive"));
      expect(() => startAgentServer(opts)).toThrow("ManagedOwnerRequired");

      const stop = await fetch(`${running.url}/trpc/serverStop`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ workload: "fixture" }),
        signal: AbortSignal.timeout(3000),
      });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toMatchObject({ result: { data: { stopped: true } } });

      await running.stop();
      running = undefined;
      const ledger = join(runtimeDir, "residency-admission.db");
      renameSync(ledger, ledger + ".saved");
      const lostLedger = await startManagedAgentServer(opts, name).catch((error: unknown) => error);
      expect(lostLedger).toEqual(new Error("ManagedAdmissionJournalMismatch"));
      expect(existsSync(ledger)).toBe(false);
      renameSync(ledger + ".saved", ledger);
      const wrong = await startManagedAgentServer(opts, "foreign").catch((error: unknown) => error);
      expect(wrong).toEqual(new Error("ManagedNodeIdentityMismatch"));
      expect(() => startAgentServer(opts)).toThrow("ManagedOwnerRequired");

      const operations = env.LLAMACTL_RESIDENCY_STORE;
      renameSync(operations, operations + ".saved");
      writeFileSync(operations, readFileSync(operations + ".saved"));
      const replaced = await startManagedAgentServer(opts, name).catch((error: unknown) => error);
      expect(replaced).toEqual(new Error("ManagedTransitionJournalMismatch"));
      renameSync(operations + ".saved", operations);
      running = await startManagedAgentServer(opts, name);
      expect(running.port).toBeGreaterThan(0);
    } finally {
      await running?.stop();
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("a managed launch refuses when the transition journal disappears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-managed-journal-"));
  const previous = process.env["LOCAL_AI_RUNTIME_DIR"];
  process.env["LOCAL_AI_RUNTIME_DIR"] = dir;
  writeFileSync(join(dir, "managed-residency-v1"), "fixture-node\n");
  let calls = 0;
  try {
    const outcome = await runDirectResidencyStart(
      "fixture",
      () => {
        calls += 1;
        return { ok: true };
      },
      {
        storePath: join(dir, "missing.sqlite"),
        group: undefined,
        isProvenDown: () => false,
        isRunning: () => false,
        log: () => undefined,
      },
    );
    expect(outcome.ran).toBe(false);
    if (!outcome.ran) expect(outcome.detail).toContain("store unavailable");
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, "LOCAL_AI_RUNTIME_DIR");
    else process.env["LOCAL_AI_RUNTIME_DIR"] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
