import { setResidencyLeaseRegistry } from "@llamactl/core/residency/leases";
import { setSessionRefcountRegistry } from "@llamactl/core/residency/sessions";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Caller, dispatchOpsChatTool, opsChatStopRefusal } from "../src/ops-chat/dispatch.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

let runtimeDir = "";
let auditPath = "";
const originalEnv = { ...process.env };

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "llamactl-opschat-apply-fence-"));
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

const transition = "2026-01-02T03:04:05.000Z";

function applyPayload(args: {
  action: string;
  phase: string;
  serverPid: number | null;
  endpoint: string | null;
  conditions: Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    action: args.action,
    path: join(runtimeDir, "workloads", "w1.yaml"),
    status: {
      phase: args.phase,
      serverPid: args.serverPid,
      endpoint: args.endpoint,
      lastTransitionTime: transition,
      conditions: args.conditions,
    },
    name: "w1",
    node: "n1",
  };
}

function dispatchWetApply(caller: Caller): ReturnType<typeof dispatchOpsChatTool> {
  return dispatchOpsChatTool(caller, {
    name: "llamactl.workload.apply",
    arguments: { yaml: "x: 1" },
    dryRun: false,
  });
}

describe("#520 ops-chat workload.apply fence refusal", () => {
  // Kills: reporting an apply whose restart was fenced as a successful mutation.
  test("R1 workloadApply StopRefused maps to apply_refused", async () => {
    const payload = applyPayload({
      action: "unchanged",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "StopRefused",
          message: "serverStop refused: SessionsActive: s1, s2",
          lastTransitionTime: transition,
        },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchWetApply(caller);

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: "apply_refused",
      message:
        "workloadApply refused by the node stop fence (StopRefused): serverStop refused: SessionsActive: s1, s2",
    });
    expect(res.result).toEqual(payload);
    expect(calls).toEqual([{ method: "workloadApply", input: { yaml: "x: 1" } }]);
  });

  // Kills: scanning only conditions[0], which is Applied=True/unchanged in the
  // preserved-running eviction shape.
  test("R2 an EvictFailed fence condition later in the list maps to apply_refused", async () => {
    const payload = applyPayload({
      action: "unchanged",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        { type: "Applied", status: "True", reason: "unchanged", lastTransitionTime: transition },
        {
          type: "EvictFailed",
          status: "False",
          reason: "EvictSessionActive",
          message:
            "eviction of 'v' did not complete (EvictSessionActive): m; replacement was not started",
          lastTransitionTime: transition,
        },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchWetApply(caller);

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: "apply_refused",
      message:
        "workloadApply refused by the node stop fence (EvictSessionActive): eviction of 'v' did not complete (EvictSessionActive): m; replacement was not started",
    });
    expect(res.result).toEqual(payload);
    expect(calls).toEqual([{ method: "workloadApply", input: { yaml: "x: 1" } }]);
  });

  // Kills: always appending ': <message>', which leaves a dangling colon when
  // the condition carries no detail.
  test("R3 a fence refusal without a condition message omits the detail suffix", async () => {
    const payload = applyPayload({
      action: "pending",
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "EvictSessionUnknown",
          lastTransitionTime: transition,
        },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchWetApply(caller);

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      code: "apply_refused",
      message: "workloadApply refused by the node stop fence (EvictSessionUnknown)",
    });
    expect(res.result).toEqual(payload);
  });

  // Kills: recognizing the session reasons but omitting the lease-backed
  // victim-busy reason emitted by eviction teardown.
  test.each([
    [
      "with detail",
      "eviction of 'v' failed (EvictVictimBusy): LeasesActive: lease-1; replacement was not started",
      "workloadApply refused by the node stop fence (EvictVictimBusy): eviction of 'v' failed (EvictVictimBusy): LeasesActive: lease-1; replacement was not started",
    ],
    ["without detail", undefined, "workloadApply refused by the node stop fence (EvictVictimBusy)"],
  ] as const)("R4 EvictVictimBusy direct-helper refusal %s", (_label, detail, expected) => {
    const payload = applyPayload({
      action: "pending",
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      conditions: [
        {
          type: "EvictFailed",
          status: "False",
          reason: "EvictVictimBusy",
          ...(detail === undefined ? {} : { message: detail }),
          lastTransitionTime: transition,
        },
      ],
    });

    expect(opsChatStopRefusal("llamactl.workload.apply", {}, payload)).toEqual({
      code: "apply_refused",
      message: expected,
    });
  });

  // Guard: a normal apply remains a successful mutation and is not a refusal.
  test("G1 a clean started apply stays ok and the helper returns null", async () => {
    const payload = applyPayload({
      action: "started",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        { type: "Applied", status: "True", reason: "started", lastTransitionTime: transition },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchWetApply(caller);

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
    expect(opsChatStopRefusal("llamactl.workload.apply", {}, payload)).toBeNull();
  });

  // Guard: this slice maps only stop-fence refusals, not every failed eviction.
  test("G2 EvictStopFailed is not mapped as a fence refusal", async () => {
    const payload = applyPayload({
      action: "pending",
      phase: "Failed",
      serverPid: null,
      endpoint: null,
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "EvictStopFailed",
          message: "boom",
          lastTransitionTime: transition,
        },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchWetApply(caller);

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual(payload);
  });

  // Guard: dry-run remains a preview and never invokes workloadApply.
  test("G3 dry-run returns the preview without calling workloadApply", async () => {
    const payload = applyPayload({
      action: "unchanged",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        {
          type: "Applied",
          status: "False",
          reason: "StopRefused",
          message: "serverStop refused: SessionsActive: s1",
          lastTransitionTime: transition,
        },
      ],
    });
    const calls: RecordedCall[] = [];
    const caller = makeFakeCaller({ workloadApply: payload }, calls);

    const res = await dispatchOpsChatTool(caller, {
      name: "llamactl.workload.apply",
      arguments: { yaml: "x: 1" },
      dryRun: true,
    });

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ dryRun: true, wouldApply: { bytes: 4 } });
    expect(calls).toEqual([]);
  });

  // Guard: a fence-looking reason on a positive condition is not a refusal.
  test("G4 StopRefused with status True is not mapped", () => {
    const payload = applyPayload({
      action: "started",
      phase: "Running",
      serverPid: 123,
      endpoint: "http://127.0.0.1:8081",
      conditions: [
        {
          type: "Applied",
          status: "True",
          reason: "StopRefused",
          message: "serverStop refused: SessionsActive: s1",
          lastTransitionTime: transition,
        },
      ],
    });

    expect(opsChatStopRefusal("llamactl.workload.apply", {}, payload)).toBeNull();
  });
});
