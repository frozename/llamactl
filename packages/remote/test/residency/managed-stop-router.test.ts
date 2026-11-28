import { server } from "@llamactl/core";
import { expect, spyOn, test } from "bun:test";

import type {
  ManagedStopProof,
  ReleaseAttemptResult,
} from "../../src/residency/admission-authority.js";
import type { ManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";

import { router } from "../../src/router.js";
import * as modelHost from "../../src/server/modelhost.js";

const workload = "managed-stop-fixture";

function admissionWithStopProbe(events: string[]): ManagedLaunchAdmission {
  return {
    run: () => Promise.resolve({ ran: false, detail: "fixture does not launch" }),
    prepareStopRelease(name, kind): ManagedStopProof {
      events.push(`prepare ${kind} ${name}`);
      return {
        verifyGeneration: () => "alive",
        release(pid): ReleaseAttemptResult {
          events.push(`release ${String(pid)}`);
          return { kind: "released", claimId: "fixture" };
        },
      };
    },
  };
}

test("serverStop snapshots the managed receipt before a verified runtime stop", async () => {
  const events: string[] = [];
  const stop = spyOn(server, "stopServer").mockImplementation((opts) => {
    events.push("stop");
    expect(opts.identity?.verifyGeneration?.(4401)).toBe("alive");
    return Promise.resolve({ stopped: true, pid: 4401, killed: false });
  });
  try {
    const caller = router.createCaller({ managedLaunchAdmission: admissionWithStopProbe(events) });
    expect(await caller.serverStop({ workload })).toEqual({
      stopped: true,
      pid: 4401,
      killed: false,
    });
    expect(events).toEqual([`prepare ModelRun ${workload}`, "stop", "release 4401"]);
  } finally {
    stop.mockRestore();
  }
});

test("modelHostStop does not settle memory after an unverified stop response", async () => {
  const events: string[] = [];
  const stop = spyOn(modelHost, "stopModelHost").mockImplementation(() => {
    events.push("stop");
    return Promise.resolve({ ok: false, pid: 4402, error: "unknown runtime generation" });
  });
  try {
    const caller = router.createCaller({ managedLaunchAdmission: admissionWithStopProbe(events) });
    expect(await caller.modelHostStop({ workload })).toMatchObject({ ok: false, pid: 4402 });
    expect(events).toEqual([`prepare ModelHost ${workload}`, "stop"]);
  } finally {
    stop.mockRestore();
  }
});

test("managed direct stops refuse without a ledger generation before invoking either engine", async () => {
  const stopRun = spyOn(server, "stopServer").mockResolvedValue({
    stopped: true,
    pid: 4401,
    killed: false,
  });
  const stopHost = spyOn(modelHost, "stopModelHost").mockResolvedValue({ ok: true, pid: 4402 });
  try {
    const caller = router.createCaller({
      managedLaunchAdmission: {
        run: () => Promise.resolve({ ran: false, detail: "fixture does not launch" }),
        prepareStopRelease: () => undefined,
      },
    });
    expect(await caller.serverStop({ workload })).toMatchObject({
      stopped: false,
      managedRefusal: "ManagedStopGenerationUnverified",
    });
    expect(await caller.modelHostStop({ workload })).toMatchObject({
      ok: false,
      error: "ManagedStopGenerationUnverified",
    });
    expect(stopRun).not.toHaveBeenCalled();
    expect(stopHost).not.toHaveBeenCalled();
  } finally {
    stopRun.mockRestore();
    stopHost.mockRestore();
  }
});

test("engine stop success with a retained charge is a managed stop refusal", async () => {
  const gate: ManagedLaunchAdmission = {
    run: () => Promise.resolve({ ran: false, detail: "fixture does not launch" }),
    prepareStopRelease: () => ({
      release: () => ({
        kind: "retained",
        claimId: "fixture",
        reason: "live-generation",
      }),
      verifyGeneration: () => "alive",
    }),
  };
  const stopRun = spyOn(server, "stopServer").mockResolvedValue({
    stopped: true,
    pid: 4401,
    killed: false,
  });
  const stopHost = spyOn(modelHost, "stopModelHost").mockResolvedValue({ ok: true, pid: 4402 });
  try {
    const caller = router.createCaller({ managedLaunchAdmission: gate });
    expect(await caller.serverStop({ workload })).toMatchObject({
      stopped: false,
      pid: 4401,
      managedRefusal: "ManagedStopReleaseUnverified",
    });
    expect(await caller.modelHostStop({ workload })).toMatchObject({
      ok: false,
      pid: 4402,
      error: "ManagedStopReleaseUnverified",
    });
  } finally {
    stopRun.mockRestore();
    stopHost.mockRestore();
  }
});
