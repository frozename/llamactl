// #410 P5a-3a, confirmed stop action for a console workload row: the
// Stop button (offered only for single-node ModelRuns on the tab node,
// disabled with a reason otherwise) and the typed-confirmation dialog
// that submits serverStop exactly once and classifies the outcome.
// Hooks come from ../node-trpc so the mutation rides the tab's
// node-scoped client; onSuccessToast is the seam the P5a-3b shell wires
// to its toast host.

import * as React from "react";

import { Button, Input } from "@/ui";

import type { ConsoleWorkloadRow } from "../workloads-scope";

import { useConsoleNode, useNodeTrpc, useNodeTrpcUtils } from "../node-trpc";
import {
  createStopController,
  STOP_GRACE_SECONDS,
  stopAvailability,
  stopDialogState,
  stopResultMessage,
} from "./stop-server-model";

type StopMessage = ReturnType<typeof stopResultMessage>;

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0, 0, 0, 0.45)",
  zIndex: 60,
};

const panelStyle: React.CSSProperties = {
  width: 420,
  maxWidth: "90vw",
  padding: 20,
  display: "grid",
  gap: 12,
  background: "var(--color-surface-1)",
  border: "1px solid var(--color-border)",
  borderRadius: "var(--r-lg)",
  color: "var(--color-text)",
};

const factRowStyle: React.CSSProperties = { display: "flex", gap: 8 };
const factTermStyle: React.CSSProperties = { color: "var(--color-text-secondary)" };
const factValueStyle: React.CSSProperties = { margin: 0 };

export interface StopServerActionProps {
  row: ConsoleWorkloadRow;
  onSuccessToast: (text: string) => void;
}

export function StopServerAction({
  row,
  onSuccessToast,
}: StopServerActionProps): React.JSX.Element | null {
  const node = useConsoleNode();
  const [open, setOpen] = React.useState(false);
  const availability = stopAvailability(row, node);

  if (!availability.offered) {
    return null;
  }

  if (!availability.enabled) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <Button variant="destructive" size="sm" disabled>
          Stop
        </Button>
        <span style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          {availability.reason}
        </span>
      </span>
    );
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        Stop
      </Button>
      {open ? (
        <StopServerDialog
          row={row}
          node={node}
          onClose={() => {
            setOpen(false);
          }}
          onSuccessToast={onSuccessToast}
        />
      ) : null}
    </>
  );
}

function StopFacts({
  row,
  node,
  endpoint,
}: {
  row: ConsoleWorkloadRow;
  node: string;
  endpoint: string | null;
}): React.JSX.Element {
  return (
    <dl style={{ margin: 0, display: "grid", gap: 4, fontSize: 13 }}>
      <div style={factRowStyle}>
        <dt style={factTermStyle}>Workload</dt>
        <dd style={factValueStyle}>{row.name}</dd>
      </div>
      <div style={factRowStyle}>
        <dt style={factTermStyle}>Target node</dt>
        <dd style={factValueStyle}>{node}</dd>
      </div>
      <div style={factRowStyle}>
        <dt style={factTermStyle}>Grace</dt>
        <dd style={factValueStyle}>{`${String(STOP_GRACE_SECONDS)}s`}</dd>
      </div>
      {endpoint !== null ? (
        <div style={factRowStyle}>
          <dt style={factTermStyle}>Endpoint</dt>
          <dd style={factValueStyle}>
            <a href={endpoint} target="_blank" rel="noopener noreferrer">
              {endpoint}
            </a>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

export interface StopServerDialogProps {
  row: ConsoleWorkloadRow;
  node: string;
  onClose: () => void;
  onSuccessToast: (text: string) => void;
}

export function StopServerDialog({
  row,
  node,
  onClose,
  onSuccessToast,
}: StopServerDialogProps): React.JSX.Element {
  const utils = useNodeTrpcUtils();
  const stopMutation = useNodeTrpc().serverStop.useMutation({ retry: false });
  const [controller] = React.useState(() =>
    createStopController({
      workload: row.name,
      node,
      endpoint: row.endpoint,
      mutate: (input) => stopMutation.mutateAsync(input),
    }),
  );
  const [typed, setTyped] = React.useState("");
  const [message, setMessage] = React.useState<StopMessage | null>(null);
  const titleId = React.useId();
  const labelId = `${titleId}-confirm`;
  const { restartWarning, endpoint } = controller.view();
  const { canSubmit } = stopDialogState({
    workload: row.name,
    typed,
    submitting: stopMutation.isPending,
  });

  function onType(value: string): void {
    controller.type(value);
    setTyped(value);
  }

  function onCancel(): void {
    controller.cancel();
    setTyped("");
    setMessage(null);
    onClose();
  }

  function onSubmit(): void {
    void (async (): Promise<void> => {
      const outcome = await controller.submit();
      if (outcome === null) {
        return;
      }
      const result = stopResultMessage(outcome, row.name);
      if (result.invalidate) {
        void utils.serverStatus.invalidate();
        void utils.workloadList.invalidate();
      }
      if (result.kind === "success") {
        onSuccessToast(result.text);
        onClose();
        return;
      }
      setMessage(result);
    })();
  }

  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} style={overlayStyle}>
      <div style={panelStyle}>
        <h2 id={titleId} style={{ margin: 0, fontSize: 16 }}>
          Stop {row.name}
        </h2>
        <StopFacts row={row} node={node} endpoint={endpoint} />
        <p style={{ margin: 0, fontSize: 12, color: "var(--color-warn)" }}>{restartWarning}</p>
        <div style={{ display: "grid", gap: 6 }}>
          <span id={labelId} style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {`Type ${row.name} to confirm`}
          </span>
          <Input
            value={typed}
            aria-labelledby={labelId}
            onChange={(event) => {
              onType(event.target.value);
            }}
          />
        </div>
        {message !== null ? (
          <p role="alert" style={{ margin: 0, fontSize: 12, color: "var(--color-err)" }}>
            {message.text}
          </p>
        ) : null}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={!canSubmit} onClick={onSubmit}>
            Stop
          </Button>
        </div>
      </div>
    </div>
  );
}
