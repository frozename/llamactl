// packages/app/test/console/stop-dialog-fence-refusal.test.ts
// Part of #520 — pins the web console Stop dialog's stop-fence refusal
// path. serverStop resolves {stopped:false, pid:null, killed:false,
// refused:{reason, active}} when the node fence refuses; the dialog must
// classify it as a refusal keyed on the reason, render the fence detail
// plus the release-session / force-unload overrides, and neither toast,
// close nor invalidate. At the pinned base stopResultMessage ignores
// `refused` and falls into the pid-identity text, so R1-R6 fail by
// assertion while G1-G3 pass.

import { describe, expect, test } from "bun:test";

import {
  afterStopEffects,
  createStopController,
  stopResultMessage,
} from "../../src/console/actions/stop-server-model.ts";

type StopMessageInput = Parameters<typeof stopResultMessage>[0];

type FenceReason = "LeasesActive" | "DrainInProgress" | "SessionsActive" | "SessionsUnknown";

// Base StopServerResult has no `refused`; the fix adds it. This local
// mirror keeps the file compiling on both sides of the change.
interface FenceRefusal {
  reason: FenceReason;
  active: string[];
}

interface FenceStopResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
  refused: FenceRefusal;
}

function fenceOutcome(refused: FenceRefusal): StopMessageInput {
  const result: FenceStopResult = { stopped: false, pid: null, killed: false, refused };
  return { ok: true, result };
}

describe("#520 stop-dialog stop-fence refusal", () => {
  // Kills: stopExecutedMessage ignoring result.refused — the base falls
  // into the pid-identity "Stop not confirmed" text with invalidate:true
  // and no code.
  test("R1: SessionsActive refusal renders the fence, ids and both overrides", () => {
    const message = stopResultMessage(
      fenceOutcome({ reason: "SessionsActive", active: ["sess-a", "sess-b"] }),
      "qwen",
    );
    expect(message.kind).toBe("refusal");
    expect(message.code).toBe("SessionsActive");
    expect(message.invalidate).toBe(false);
    expect(message.text).toContain(
      "refused by the node's stop fence (SessionsActive: sess-a, sess-b)",
    );
    expect(message.text).toContain("nothing was stopped");
    expect(message.text).toContain("llamactl residency release-session");
    expect(message.text).toContain("llamactl residency force-unload qwen");
    expect(message.text).not.toContain("Stop not confirmed");
    expect(message.text).not.toContain("null");
    expect(message.text).not.toContain("PID");
  });

  // Kills: an unconditional `: ${ids.join(", ")}` suffix — an empty id
  // list must leave the bare reason with no trailing colon.
  test("R2: SessionsUnknown renders the bare reason with no id suffix", () => {
    const message = stopResultMessage(
      fenceOutcome({ reason: "SessionsUnknown", active: [] }),
      "qwen",
    );
    expect(message.kind).toBe("refusal");
    expect(message.code).toBe("SessionsUnknown");
    expect(message.invalidate).toBe(false);
    expect(message.text).toContain("(SessionsUnknown)");
    expect(message.text).not.toContain("SessionsUnknown:");
  });

  // Kills: one template that ignores the reason, or offering the session
  // override for a lease/drain fence.
  test("R3: lease and drain refusals name their reason and offer only force-unload", () => {
    const cases: { reason: FenceReason; active: string[]; fragment: string }[] = [
      { reason: "LeasesActive", active: ["lease-1"], fragment: "(LeasesActive: lease-1)" },
      { reason: "DrainInProgress", active: [], fragment: "(DrainInProgress)" },
    ];
    for (const { reason, active, fragment } of cases) {
      const message = stopResultMessage(fenceOutcome({ reason, active }), "qwen");
      expect(message.kind).toBe("refusal");
      expect(message.code).toBe(reason);
      expect(message.invalidate).toBe(false);
      expect(message.text).toContain(fragment);
      expect(message.text).toContain("llamactl residency force-unload qwen");
      expect(message.text).not.toContain("release-session");
    }
  });

  // Kills: dropping the string filter on the active ids.
  test("R4: non-string active entries are dropped from the fence detail", () => {
    // The wire type is string[], but the rendered ids must survive a node
    // sending anything else.
    const active = ["sess-a", 7, null, "sess-b"] as unknown as string[];
    const message = stopResultMessage(fenceOutcome({ reason: "SessionsActive", active }), "qwen");
    expect(message.kind).toBe("refusal");
    expect(message.code).toBe("SessionsActive");
    expect(message.text).toContain("(SessionsActive: sess-a, sess-b)");
    expect(message.text).not.toContain("7");
    expect(message.text).not.toContain("null");
  });

  // Kills: a fence refusal toasting, closing the dialog or invalidating.
  test("R5: a fence refusal neither toasts nor closes nor invalidates", () => {
    const message = stopResultMessage(
      fenceOutcome({ reason: "SessionsActive", active: ["sess-a", "sess-b"] }),
      "qwen",
    );
    expect(message.kind).toBe("refusal");
    expect(message.code).toBe("SessionsActive");
    const effects = afterStopEffects(message);
    expect(effects.toast).toBeNull();
    expect(effects.close).toBe(false);
    expect(effects.invalidate).toEqual([]);
  });

  // Pass-through pin: the controller must hand the refused result to
  // stopResultMessage untouched so the fence classification still fires.
  test("R6: the controller passes a fence-refused result through untouched", async () => {
    const result: FenceStopResult = {
      stopped: false,
      pid: null,
      killed: false,
      refused: { reason: "SessionsActive", active: ["sess-a", "sess-b"] },
    };
    const controller = createStopController({
      workload: "qwen",
      node: "local",
      endpoint: null,
      mutate: () => Promise.resolve(result),
    });
    controller.type("qwen");
    const outcome = await controller.submit();
    if (!outcome?.ok) {
      throw new Error("expected the fence result to resolve ok");
    }
    expect(outcome.result).toEqual(result);
    expect(stopResultMessage(outcome, "qwen").code).toBe("SessionsActive");
  });

  // Guard: passes at base and on the fix — a confirmed stop is a success.
  test("G1: a confirmed stop is still a success", () => {
    const message = stopResultMessage({
      ok: true,
      result: { stopped: true, pid: 42, killed: false },
    });
    expect(message.kind).toBe("success");
    expect(message.invalidate).toBe(true);
  });

  // Guard: passes at base and on the fix — without `refused` the
  // pid-identity refusal text is unchanged.
  test("G2: an unconfirmed stop without refused keeps the pid-identity refusal", () => {
    const message = stopResultMessage({
      ok: true,
      result: { stopped: false, pid: 4242, killed: false },
    });
    expect(message.kind).toBe("refusal");
    expect(message.text).toContain("Stop not confirmed");
    expect(message.text).toContain("4242");
  });

  // Guard: passes at base (no fence text renders) and on the fix — the
  // omitted workload must render the <workload> placeholder, never
  // "undefined".
  test("G3: an omitted workload renders the <workload> placeholder, never undefined", () => {
    const message = stopResultMessage(
      fenceOutcome({ reason: "SessionsActive", active: ["sess-a"] }),
    );
    expect(message.text).not.toContain("undefined");
    if (message.code === "SessionsActive") {
      expect(message.text).toContain("llamactl residency force-unload <workload>");
    }
  });
});
