// #410 P5a, stop-server dialog view model: availability gating,
// dialog state, controller with cancel/submit/view, and result
// message classification.

import type { ConsoleWorkloadRow } from "../workloads-scope";

import { classifyTransportError } from "../../lib/transport/errors";

export const STOP_GRACE_SECONDS = 5;

export interface StopServerResult {
  stopped: boolean;
  pid: number | null;
  killed: boolean;
}

export type StopOutcome = { ok: true; result: StopServerResult } | { ok: false; error: unknown };

export function stopAvailability(
  row: ConsoleWorkloadRow,
  tabNode: string,
):
  | { offered: false }
  | { offered: true; enabled: true }
  | { offered: true; enabled: false; reason: string } {
  if (row.kind !== "ModelRun" || row.node !== tabNode) {
    return { offered: false };
  }

  if (row.workerNodes.length > 0) {
    return {
      offered: true,
      enabled: false,
      reason: `Stopping only the coordinator would leave rpc-server running on ${row.workerNodes.join(", ")}. Use \`llamactl delete workload ${row.name}\` for a full ordered stop, or \`llamactl server stop\` on ${row.node} plus the rpc-server stops.`,
    };
  }

  return { offered: true, enabled: true };
}

export function stopDialogState(opts: { workload: string; typed: string; submitting: boolean }): {
  workload: string;
  canSubmit: boolean;
} {
  return {
    workload: opts.workload,
    canSubmit: !opts.submitting && opts.typed === opts.workload,
  };
}

interface StopControllerInternal {
  view: () => {
    workload: string;
    targetNode: string;
    endpoint: string | null;
    restartWarning: string;
  };
  type: (text: string) => void;
  cancel: () => void;
  submit: () => Promise<StopOutcome | null>;
}

export function createStopController(opts: {
  workload: string;
  node: string;
  endpoint: string | null;
  mutate: (input: { workload: string; graceSeconds: number }) => Promise<StopServerResult>;
}): StopControllerInternal {
  let typed = "";
  let submitting = false;
  let cancelled = false;

  const restartWarning =
    "A controller or reconciler may restart this workload while its manifest remains.";

  return {
    view: () => ({
      workload: opts.workload,
      targetNode: opts.node,
      endpoint: opts.endpoint,
      restartWarning,
    }),

    type: (text: string): void => {
      typed = text;
    },

    cancel: (): void => {
      cancelled = true;
    },

    submit: async (): Promise<StopOutcome | null> => {
      const dialogState = stopDialogState({
        workload: opts.workload,
        typed,
        submitting,
      });

      if (cancelled || submitting || !dialogState.canSubmit) {
        return null;
      }

      submitting = true;

      try {
        const result = await opts.mutate({
          workload: opts.workload,
          graceSeconds: STOP_GRACE_SECONDS,
        });
        return { ok: true, result };
      } catch (error) {
        return { ok: false, error };
      } finally {
        submitting = false;
      }
    },
  };
}

const REFUSAL_CODES = new Set([
  "workload_not_found",
  "unsupported_workload_kind",
  "workload_node_mismatch",
  "multi_node_workload",
]);

const REFUSAL_MESSAGES: Record<string, (workload: string) => string> = {
  workload_not_found: () => "The workload was not found on this node.",
  unsupported_workload_kind: () => "This workload kind cannot be stopped through the dialog.",
  workload_node_mismatch: (workload) =>
    `This workload runs on a different node. Use the node-scoped view or \`llamactl delete workload ${workload}\`.`,
  multi_node_workload: (workload) =>
    `This is a multi-node workload. Use \`llamactl delete workload ${workload}\` for a full ordered stop.`,
};

function stopExecutedMessage(result: StopServerResult): {
  kind: "success" | "refusal";
  text: string;
  invalidate: boolean;
} {
  const { stopped, pid, killed } = result;
  if (stopped) {
    return {
      kind: "success",
      text:
        pid !== null
          ? `Stopped llama-server (PID ${String(pid)})${killed ? " after SIGKILL" : ""}`
          : "Stopped",
      invalidate: true,
    };
  }
  return {
    kind: "refusal",
    text:
      pid !== null
        ? `Stop not confirmed: llamactl could not verify that PID ${String(pid)} is still this workload's llama-server. Its tracking record was kept. Check with \`llamactl server status\``
        : "Stop not confirmed: llamactl could not identify the llama-server process for this workload. Its tracking record was kept. Check with `llamactl server status`",
    invalidate: true,
  };
}

export function stopResultMessage(
  outcome: StopOutcome,
  workload?: string,
): {
  kind: "success" | "refusal" | "error";
  code?: string;
  text: string;
  invalidate: boolean;
} {
  if (outcome.ok) {
    return stopExecutedMessage(outcome.result);
  }

  const c = classifyTransportError(outcome.error);

  if (c.consoleCode !== undefined && REFUSAL_CODES.has(c.consoleCode)) {
    const message =
      REFUSAL_MESSAGES[c.consoleCode]?.(workload ?? "this workload") ??
      "The operation was refused.";
    return {
      kind: "refusal",
      code: c.consoleCode,
      text: message,
      invalidate: false,
    };
  }

  return {
    kind: "error",
    text: c.message,
    invalidate: false,
  };
}
