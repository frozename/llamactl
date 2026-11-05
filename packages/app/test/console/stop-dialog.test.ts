// packages/app/test/console/stop-dialog.test.ts
// Issue #410, P5a RED — pins the confirmed stop action. The button is
// offered only for single-node ModelRuns on the tab node (ModelHosts
// and foreign-node rows never see it; multi-node ModelRuns see it
// disabled with the worker list and the CLI escape hatches). The
// dialog submits once per confirmation, only when the typed name
// matches exactly, and classifies the outcome: stopped → success,
// unconfirmed → inline refusal, precheck 409/404 → inline refusal,
// anything else → error. The module does not exist at the base commit,
// so every case fails by assertion through the import-catch pattern —
// never by import error.

import { describe, expect, test } from "bun:test";

const STOP_SPEC = "../../src/console/actions/stop-server-model.ts";

interface WorkloadRow {
  name: string;
  kind: "ModelRun" | "ModelHost";
  node: string;
  rel: string;
  phase: "Running" | "Stopped" | "Mismatch" | "Unreachable" | "Foreign";
  endpoint: string | null;
  workerCount: number;
  workerNodes: string[];
}

interface StopAvailabilityResult {
  offered: boolean;
  enabled?: boolean;
  reason?: string;
}

interface StopDialogStateResult {
  workload: string;
  canSubmit: boolean;
}

interface StopCallInput {
  workload: string;
  graceSeconds: number;
}

interface StopResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

type StopOutcome = { ok: true; result: StopResult } | { ok: false; error: unknown };

interface StopControllerView {
  workload: string;
  targetNode: string;
  endpoint: string | null;
  restartWarning: string;
}

interface StopController {
  view: () => StopControllerView;
  type: (text: string) => void;
  cancel: () => void;
  submit: () => Promise<StopOutcome | null>;
}

interface StopResultMessage {
  kind: "success" | "refusal" | "error";
  text: string;
  invalidate: boolean;
  code?: string;
}

interface AfterStopEffectsResult {
  toast: string | null;
  close: boolean;
  invalidate: string[];
}

interface StopModule {
  stopAvailability?: (row: WorkloadRow, tabNode: string) => StopAvailabilityResult;
  stopDialogState?: (opts: {
    workload: string;
    typed: string;
    submitting: boolean;
  }) => StopDialogStateResult;
  stopButtonDisabled?: (dialogState: StopDialogStateResult) => boolean;
  serverStopCall?: (workload: string) => StopCallInput;
  afterStopEffects?: (result: StopResultMessage) => AfterStopEffectsResult;
  createStopController?: (opts: {
    workload: string;
    node: string;
    endpoint: string | null;
    mutate: (input: StopCallInput) => Promise<StopResult>;
  }) => StopController;
  stopResultMessage?: (outcome: StopOutcome, workload?: string) => StopResultMessage;
  STOP_GRACE_SECONDS?: number;
}

async function importStop(): Promise<StopModule | null> {
  return (await import(STOP_SPEC).catch(() => null)) as StopModule | null;
}

function makeRow(overrides: Partial<WorkloadRow> = {}): WorkloadRow {
  return {
    name: "qwen",
    kind: "ModelRun",
    node: "local",
    rel: "hf.co/qwen.gguf",
    phase: "Running",
    endpoint: "http://127.0.0.1:8080",
    workerCount: 0,
    workerNodes: [],
    ...overrides,
  };
}

function makeController(mod: StopModule): {
  controller: StopController;
  calls: StopCallInput[];
} {
  const calls: StopCallInput[] = [];
  const controller = mod.createStopController!({
    workload: "qwen",
    node: "local",
    endpoint: "http://127.0.0.1:8080",
    mutate: (input: StopCallInput) => {
      calls.push(input);
      return Promise.resolve({ stopped: true, pid: 42, killed: false });
    },
  });
  return { controller, calls };
}

describe("stop action availability (#410 P5a)", () => {
  test("a single-node ModelRun on the tab node is offered and enabled", async () => {
    const mod = await importStop();
    expect(mod?.stopAvailability).toBeFunction();

    expect(mod!.stopAvailability!(makeRow(), "local")).toEqual({
      offered: true,
      enabled: true,
    });
  });

  test("a ModelRun on another node is not offered", async () => {
    const mod = await importStop();
    expect(mod?.stopAvailability).toBeFunction();

    expect(mod!.stopAvailability!(makeRow({ node: "gpu-1" }), "local")).toMatchObject({
      offered: false,
    });
  });

  test("a ModelHost on the tab node is not offered", async () => {
    const mod = await importStop();
    expect(mod?.stopAvailability).toBeFunction();

    expect(mod!.stopAvailability!(makeRow({ kind: "ModelHost" }), "local")).toMatchObject({
      offered: false,
    });
  });

  test("a multi-node ModelRun is offered disabled with workers and CLI hints in the reason", async () => {
    const mod = await importStop();
    expect(mod?.stopAvailability).toBeFunction();

    const availability = mod!.stopAvailability!(
      makeRow({ workerCount: 2, workerNodes: ["gpu-1", "gpu-2"] }),
      "local",
    );
    expect(availability).toMatchObject({ offered: true, enabled: false });
    expect(typeof availability.reason).toBe("string");
    for (const fragment of [
      "gpu-1",
      "gpu-2",
      "llamactl delete workload qwen",
      "llamactl server stop",
    ]) {
      expect(availability.reason).toContain(fragment);
    }
  });
});

describe("stop dialog state (#410 P5a)", () => {
  test("submit stays disabled until the typed name matches exactly", async () => {
    const mod = await importStop();
    expect(mod?.stopDialogState).toBeFunction();

    for (const typed of ["", "qwe", "Qwen", " qwen", "qwen "]) {
      const state = mod!.stopDialogState!({ workload: "qwen", typed, submitting: false });
      expect(state.canSubmit).toBe(false);
      expect(state.workload).toBe("qwen");
    }
  });

  test("an in-flight submit keeps the button disabled", async () => {
    const mod = await importStop();
    expect(mod?.stopDialogState).toBeFunction();

    expect(
      mod!.stopDialogState!({ workload: "qwen", typed: "qwen", submitting: true }).canSubmit,
    ).toBe(false);
  });

  test("the exact name enables submit while idle", async () => {
    const mod = await importStop();
    expect(mod?.stopDialogState).toBeFunction();

    const state = mod!.stopDialogState!({
      workload: "qwen",
      typed: "qwen",
      submitting: false,
    });
    expect(state.canSubmit).toBe(true);
    expect(state.workload).toBe("qwen");
  });
});

describe("stop controller (#410 P5a)", () => {
  test("exports the five-second grace constant", async () => {
    const mod = await importStop();
    expect(mod?.STOP_GRACE_SECONDS).toBe(5);
  });

  test("view exposes the workload, tab node, endpoint and restart warning", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();

    const { controller } = makeController(mod!);
    const view = controller.view();
    expect(view).toMatchObject({
      workload: "qwen",
      targetNode: "local",
      endpoint: "http://127.0.0.1:8080",
    });
    expect(view.restartWarning).toMatch(/controller or reconciler may restart/i);
  });

  test("a cancel before typing keeps submit a no-op", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();

    const { controller, calls } = makeController(mod!);
    controller.cancel();
    controller.type("qwen");
    expect(await controller.submit()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a cancel after typing keeps submit a no-op", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();

    const { controller, calls } = makeController(mod!);
    controller.type("qwen");
    controller.cancel();
    expect(await controller.submit()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a mistyped name keeps submit a no-op", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();

    const { controller, calls } = makeController(mod!);
    controller.type("qwe");
    expect(await controller.submit()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("concurrent submits collapse into exactly one mutate call", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();

    const { controller, calls } = makeController(mod!);
    controller.type("qwen");
    const results = await Promise.all([controller.submit(), controller.submit()]);
    expect(calls).toEqual([{ workload: "qwen", graceSeconds: 5 }]);
    const settled = results.filter((r) => r === null);
    const succeeded = results.filter((r) => r !== null);
    expect(settled).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toEqual({
      ok: true,
      result: { stopped: true, pid: 42, killed: false },
    });
  });
});

describe("stop result message (#410 P5a)", () => {
  test("a confirmed stop is a success that invalidates workload state", async () => {
    const mod = await importStop();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: true, pid: 42, killed: false },
    });
    expect(message.kind).toBe("success");
    expect(message.invalidate).toBe(true);
  });

  test("an unconfirmed stop is a refusal naming the pid and the status verb", async () => {
    const mod = await importStop();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: false, pid: 4242, killed: false },
    });
    expect(message.kind).toBe("refusal");
    expect(message.invalidate).toBe(true);
    expect(message.text).toContain("Stop not confirmed");
    expect(message.text).toContain("4242");
    expect(message.text).toContain("llamactl server status");
  });

  test("precheck refusal codes surface as inline refusals without invalidation", async () => {
    const mod = await importStop();
    expect(mod?.stopResultMessage).toBeFunction();

    const cases: [number, string][] = [
      [409, "workload_node_mismatch"],
      [409, "multi_node_workload"],
      [409, "unsupported_workload_kind"],
      [404, "workload_not_found"],
    ];
    for (const [status, code] of cases) {
      const message = mod!.stopResultMessage!(
        {
          ok: false,
          error: {
            message: "x",
            meta: { response: { status }, responseJSON: { error: code } },
          },
        },
        "qwen",
      );
      expect(message.kind).toBe("refusal");
      expect(message.code).toBe(code);
      expect(message.invalidate).toBe(false);
      expect(typeof message.text).toBe("string");
      expect(message.text.length).toBeGreaterThan(0);
      expect(message.text).not.toContain("${");
      if (code === "workload_node_mismatch" || code === "multi_node_workload") {
        expect(message.text).toContain("llamactl delete workload qwen");
      }
    }
  });

  test("an unconfirmed stop without a pid renders no null placeholder", async () => {
    const mod = await importStop();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: false, pid: null, killed: false },
    });
    expect(message.kind).toBe("refusal");
    expect(message.invalidate).toBe(true);
    expect(message.text).toContain("Stop not confirmed");
    expect(message.text).not.toContain("null");
  });

  test("unclassified failures are errors without invalidation", async () => {
    const mod = await importStop();
    expect(mod?.stopResultMessage).toBeFunction();

    const plain = mod!.stopResultMessage!({ ok: false, error: new Error("boom") });
    expect(plain.kind).toBe("error");
    expect(plain.invalidate).toBe(false);

    const unknown = mod!.stopResultMessage!({
      ok: false,
      error: {
        message: "x",
        meta: { response: { status: 500 }, responseJSON: { error: "something_else" } },
      },
    });
    expect(unknown.kind).toBe("error");
    expect(unknown.invalidate).toBe(false);
  });
});

describe("serverStop call shape (#410 P5a-3a)", () => {
  test("serverStopCall returns exactly the workload and a five-second grace", async () => {
    const mod = await importStop();
    expect(mod?.serverStopCall).toBeFunction();

    expect(mod!.serverStopCall!("qwen")).toEqual({ workload: "qwen", graceSeconds: 5 });
  });

  test("serverStopCall tracks the exported grace constant for any workload", async () => {
    const mod = await importStop();
    expect(mod?.serverStopCall).toBeFunction();
    expect(mod?.STOP_GRACE_SECONDS).toBeNumber();

    for (const workload of ["qwen", "llama-3", "gemma-4-26b"]) {
      expect(mod!.serverStopCall!(workload)).toEqual({
        workload,
        graceSeconds: mod!.STOP_GRACE_SECONDS!,
      });
    }
  });

  test("a confirmed controller submit sends exactly one serverStopCall payload", async () => {
    const mod = await importStop();
    expect(mod?.createStopController).toBeFunction();
    expect(mod?.serverStopCall).toBeFunction();

    const { controller, calls } = makeController(mod!);
    controller.type("qwen");
    const outcome = await controller.submit();
    expect(outcome).not.toBeNull();
    expect(calls).toEqual([mod!.serverStopCall!("qwen")]);
    expect(calls).toEqual([{ workload: "qwen", graceSeconds: 5 }]);
  });
});

describe("stop button disabled gate (#410 P5a-3a)", () => {
  test("the button is enabled exactly when the dialog state allows submit", async () => {
    const mod = await importStop();
    expect(mod?.stopButtonDisabled).toBeFunction();

    expect(mod!.stopButtonDisabled!({ workload: "qwen", canSubmit: true })).toBe(false);
    expect(mod!.stopButtonDisabled!({ workload: "qwen", canSubmit: false })).toBe(true);
  });

  test("every mismatched typed value keeps the stop button disabled", async () => {
    const mod = await importStop();
    expect(mod?.stopButtonDisabled).toBeFunction();
    expect(mod?.stopDialogState).toBeFunction();

    for (const typed of ["", "qwe", "Qwen", " qwen", "qwen ", "qwen2"]) {
      const state = mod!.stopDialogState!({ workload: "qwen", typed, submitting: false });
      expect(mod!.stopButtonDisabled!(state)).toBe(true);
    }
  });

  test("the exact typed name on an idle dialog enables the stop button", async () => {
    const mod = await importStop();
    expect(mod?.stopButtonDisabled).toBeFunction();
    expect(mod?.stopDialogState).toBeFunction();

    const state = mod!.stopDialogState!({ workload: "qwen", typed: "qwen", submitting: false });
    expect(mod!.stopButtonDisabled!(state)).toBe(false);
  });

  test("an in-flight submit re-disables the stop button", async () => {
    const mod = await importStop();
    expect(mod?.stopButtonDisabled).toBeFunction();
    expect(mod?.stopDialogState).toBeFunction();

    const state = mod!.stopDialogState!({ workload: "qwen", typed: "qwen", submitting: true });
    expect(mod!.stopButtonDisabled!(state)).toBe(true);
  });
});

describe("after-stop effects (#410 P5a-3a)", () => {
  const refusalOutcome = (code: string): StopOutcome => ({
    ok: false,
    error: {
      message: "x",
      meta: { response: { status: 409 }, responseJSON: { error: code } },
    },
  });

  test("a confirmed stop toasts the success text, closes, and invalidates both queries", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: true, pid: 42, killed: false },
    });
    const effects = mod!.afterStopEffects!(message);
    expect(effects.toast).toBe(message.text);
    expect(effects.close).toBe(true);
    expect(effects.invalidate).toEqual(["serverStatus", "workloadList"]);
  });

  test("an unconfirmed stop invalidates both queries without toast or close", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: false, pid: 4242, killed: false },
    });
    expect(message.kind).toBe("refusal");
    const effects = mod!.afterStopEffects!(message);
    expect(effects.toast).toBeNull();
    expect(effects.close).toBe(false);
    expect(effects.invalidate).toEqual(["serverStatus", "workloadList"]);
  });

  test("a precheck refusal neither toasts nor closes nor invalidates", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    for (const code of [
      "workload_not_found",
      "unsupported_workload_kind",
      "workload_node_mismatch",
      "multi_node_workload",
    ]) {
      const message = mod!.stopResultMessage!(refusalOutcome(code), "qwen");
      expect(message.kind).toBe("refusal");
      const effects = mod!.afterStopEffects!(message);
      expect(effects.toast).toBeNull();
      expect(effects.close).toBe(false);
      expect(effects.invalidate).toEqual([]);
    }
  });

  test("a transport error neither toasts nor closes nor invalidates", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({ ok: false, error: new Error("boom") });
    expect(message.kind).toBe("error");
    const effects = mod!.afterStopEffects!(message);
    expect(effects.toast).toBeNull();
    expect(effects.close).toBe(false);
    expect(effects.invalidate).toEqual([]);
  });

  test("only a success result closes the dialog", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const messages = [
      mod!.stopResultMessage!({ ok: true, result: { stopped: true, pid: 1, killed: false } }),
      mod!.stopResultMessage!({ ok: true, result: { stopped: false, pid: 1, killed: false } }),
      mod!.stopResultMessage!(refusalOutcome("multi_node_workload"), "qwen"),
      mod!.stopResultMessage!({ ok: false, error: new Error("boom") }),
    ];
    for (const message of messages) {
      expect(mod!.afterStopEffects!(message).close).toBe(message.kind === "success");
    }
  });

  test("only a success result produces a toast", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const messages = [
      mod!.stopResultMessage!({ ok: true, result: { stopped: true, pid: null, killed: true } }),
      mod!.stopResultMessage!({ ok: true, result: { stopped: false, pid: null, killed: false } }),
      mod!.stopResultMessage!(refusalOutcome("workload_not_found"), "qwen"),
      mod!.stopResultMessage!({ ok: false, error: new Error("boom") }),
    ];
    for (const message of messages) {
      const effects = mod!.afterStopEffects!(message);
      if (message.kind === "success") {
        expect(effects.toast).toBe(message.text);
      } else {
        expect(effects.toast).toBeNull();
      }
    }
  });

  test("the invalidate list is exactly serverStatus and workloadList when set", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();

    const set = mod!.afterStopEffects!({ kind: "success", text: "t", invalidate: true });
    expect(set.invalidate).toEqual(["serverStatus", "workloadList"]);
    expect(set.invalidate).toHaveLength(2);
  });

  test("the invalidate list is empty when the result does not invalidate", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();

    for (const kind of ["success", "refusal", "error"] as const) {
      const effects = mod!.afterStopEffects!({ kind, text: "t", invalidate: false });
      expect(effects.invalidate).toEqual([]);
    }
  });

  test("a stopped:true pipeline toasts once and closes with both invalidations", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: true, pid: 7, killed: true },
    });
    const effects = mod!.afterStopEffects!(message);
    expect(message.kind).toBe("success");
    expect(typeof effects.toast).toBe("string");
    expect(effects.close).toBe(true);
    expect(effects.invalidate).toContain("serverStatus");
    expect(effects.invalidate).toContain("workloadList");
  });

  test("a SIGKILL-confirmed stop is a closing success toast naming the pid", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: true, pid: 9, killed: true },
    });
    const effects = mod!.afterStopEffects!(message);
    expect(message.text).toContain("SIGKILL");
    expect(message.text).toContain("9");
    expect(effects.close).toBe(true);
    expect(effects.toast).toBe(message.text);
  });

  test("the effects object carries exactly toast, close and invalidate", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();

    const effects = mod!.afterStopEffects!({ kind: "success", text: "t", invalidate: true });
    expect(Object.keys(effects).sort()).toEqual(["close", "invalidate", "toast"]);
  });

  test("a stopped:false pipeline stays inline with no toast and no close", async () => {
    const mod = await importStop();
    expect(mod?.afterStopEffects).toBeFunction();
    expect(mod?.stopResultMessage).toBeFunction();

    const message = mod!.stopResultMessage!({
      ok: true,
      result: { stopped: false, pid: null, killed: false },
    });
    const effects = mod!.afterStopEffects!(message);
    expect(message.kind).toBe("refusal");
    expect(effects.toast).toBeNull();
    expect(effects.close).toBe(false);
    expect(effects.invalidate).toContain("serverStatus");
    expect(effects.invalidate).toContain("workloadList");
  });
});
