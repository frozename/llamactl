import { server } from "@llamactl/core";
import { expect, spyOn, test } from "bun:test";

import type { ManagedLaunchAdmission } from "../../src/residency/managed-launch-admission.js";

import { router } from "../../src/router.js";
import * as modelHost from "../../src/server/modelhost.js";

const workload = "managed-stop-fixture";

function admissionWithStopProbe(events: string[]): ManagedLaunchAdmission {
  return {
    run: () => Promise.resolve({ ran: false, detail: "fixture does not launch" }),
    prepareStopRelease(name, kind) {
      events.push(`prepare ${kind} ${name}`);
      return (pid) => {
        events.push(`release ${String(pid)}`);
        return { kind: "released", claimId: "fixture" };
      };
    },
  };
}

test("serverStop snapshots the managed receipt before a verified runtime stop", async () => {
  const events: string[] = [];
  const stop = spyOn(server, "stopServer").mockImplementation(() => {
    events.push("stop");
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
