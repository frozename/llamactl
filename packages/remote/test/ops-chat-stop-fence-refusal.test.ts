import { createResidencyLeases, setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import {
  createSessionRefcounts,
  setSessionRefcountRegistry,
} from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOpsChatAudit } from "../src/ops-chat/audit.js";
import { type Caller, dispatchOpsChatTool } from "../src/ops-chat/dispatch.js";
import { router } from "../src/router.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let runtimeDir = "";
let auditPath = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-opschat-stop-fence-"));
  auditPath = join(runtimeDir, "audit.jsonl");
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv, {
    LLAMACTL_OPS_CHAT_AUDIT: auditPath,
    DEV_STORAGE: runtimeDir,
    LOCAL_AI_RUNTIME_DIR: runtimeDir,
    LLAMACTL_CONFIG: join(runtimeDir, "config"),
    LLAMACTL_WORKLOADS_DIR: join(runtimeDir, "workloads"),
  });
});

afterEach(() => {
  setResidencyLeaseRegistry(null);
  setSessionRefcountRegistry(null);
  for (const k of Object.keys(process.env)) Reflect.deleteProperty(process.env, k);
  Object.assign(process.env, originalEnv);
  rmSync(runtimeDir, { recursive: true, force: true });
});

type RecordedCall = { method: string; input: unknown };

function makeFakeCaller(handlers: Record<string, unknown>, calls: RecordedCall[]): Caller {
  const stubs: Record<string, (input: unknown) => Promise<unknown>> = {};
  for (const [method, reply] of Object.entries(handlers)) {
    stubs[method] = async (input: unknown): Promise<unknown> => {
      await Promise.resolve();
      calls.push({ method, input });
      return reply;
    };
  }
  return { ...stubs } as unknown as Caller;
}

describe("#520 ops-chat stop-fence refusal", () => {
  // Kills: dispatch reporting a fence-refused stop as ok:true.
  test("R1 server.stop SessionsActive refusal maps to stop_refused", async () => {
    const payload = {
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["s1", "s2"] },
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ serverStop: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(false);
    expect(res.tier).toBe("mutation-dry-run-safe");
    expect(res.error).toEqual({
      code: "stop_refused",
      message:
        "serverStop refused by the node stop fence (SessionsActive: s1, s2); nothing was stopped",
    });
    expect(res.result).toEqual(payload);
    expect(calls).toEqual([{ method: "serverStop", input: { workload: "w1" } }]);
  });

  // Kills: always appending ': <ids>' to a stop-fence refusal with no active ids.
  test("R2 server.stop SessionsUnknown refusal omits the empty id list", async () => {
    const payload = {
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsUnknown", active: [] },
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ serverStop: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: "stop_refused",
      message: "serverStop refused by the node stop fence (SessionsUnknown); nothing was stopped",
    });
    expect(res.result).toEqual(payload);
    expect(calls).toEqual([{ method: "serverStop", input: { workload: "w1" } }]);
  });

  // Kills: treating a preserved-manifest delete as success.
  test("R3 workload.delete stop refusal maps to delete_refused", async () => {
    const payload = {
      ok: false,
      name: "w1",
      stops: [],
      error: "serverStop on n1 refused (SessionsActive: s1); manifest preserved",
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadDelete: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.workload.delete",
      arguments: { name: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(false);
    expect(res.tier).toBe("mutation-destructive");
    expect(res.error).toEqual({
      code: "delete_refused",
      message:
        "workloadDelete refused: serverStop on n1 refused (SessionsActive: s1); manifest preserved",
    });
    expect(res.result).toEqual(payload);
    expect(calls).toEqual([
      { method: "workloadDelete", input: { name: "w1", keepRunning: false } },
    ]);
  });

  // Kills: ignoring manifestPreserved on a composite destroy refusal.
  test("R4 composite.destroy stop refusal maps to destroy_refused", async () => {
    const payload = {
      dryRun: false,
      ok: false,
      removed: [],
      errors: [
        {
          ref: { kind: "workload", name: "n1" },
          message: "serverStop on n1 refused (SessionsActive: s1); composite manifest preserved",
        },
      ],
      purgedVolumes: false,
      manifestPreserved: true,
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ compositeDestroy: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.composite.destroy",
      arguments: { name: "kb-stack" },
      dryRun: false,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: "destroy_refused",
      message: "composite/kb-stack not destroyed: a workload stop was refused; manifest preserved",
    });
  });

  // Kills: operatorRunTool auditing a fenced stop as ok:true; a fix that releases sessions.
  test("R5 operatorRunTool end-to-end maps and audits a fenced server.stop", async () => {
    const reg = createResidencyLeases();
    setResidencyLeaseRegistry(reg);
    const sessions = createSessionRefcounts({ idleTimeoutMs: 60_000 });
    setSessionRefcountRegistry(sessions);
    const acquired = sessions.acquire("s1", "w1");
    if (!acquired.ok) throw new Error("session acquire failed");
    sessions.release("s1", acquired.generation);

    const caller = router.createCaller({});
    const res = await caller.operatorRunTool({
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: false,
    });

    const message =
      "serverStop refused by the node stop fence (SessionsActive: s1); nothing was stopped";
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("stop_refused");
    expect(res.error?.message).toBe(message);

    const audit = readOpsChatAudit({ path: auditPath });
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]?.ok).toBe(false);
    expect(audit.entries[0]?.errorCode).toBe("stop_refused");
    expect(audit.entries[0]?.errorMessage).toBe(message);
    expect(sessions.activeSessions("w1")).toEqual(["s1"]);
    expect(reg.snapshot("w1").phase).toBe("open");
  });

  // Guard: a verified stop is still a successful mutation result.
  test("G1 server.stop stopped:true stays ok", async () => {
    const payload = { stopped: true, pid: 123, killed: false };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ serverStop: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
  });

  // Guard: only explicit fence refusals map; an unverified stop without refused is unchanged.
  test("G2 server.stop stopped:false without refused stays ok", async () => {
    const payload = { stopped: false, pid: null, killed: false };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ serverStop: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
  });

  // Guard: an already-absent manifest delete failure without a refusal string stays unchanged.
  test("G3 workload.delete ok:false without error string stays ok", async () => {
    const payload = { ok: false, name: "w1", stops: [] };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadDelete: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.workload.delete",
      arguments: { name: "w1" },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
  });

  // Guard: dry-run remains a preview and never invokes serverStop.
  test("G4 server.stop dry-run stays ok without calling serverStop", async () => {
    const payload = {
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["s1"] },
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ serverStop: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.server.stop",
      arguments: { workload: "w1" },
      dryRun: true,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(calls).toEqual([]);
  });

  // Guard: composite errors without a preserved manifest are not stop-fence refusals.
  test("G5 composite.destroy manifestPreserved:false stays ok", async () => {
    const payload = {
      dryRun: false,
      ok: false,
      removed: [],
      errors: [
        {
          ref: { kind: "workload", name: "n1" },
          message: "serverStop on n1 failed; composite manifest removed",
        },
      ],
      purgedVolumes: false,
      manifestPreserved: false,
    };
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ compositeDestroy: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.composite.destroy",
      arguments: { name: "kb-stack" },
      dryRun: false,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
  });
});
