import * as React from "react";

import type { ProposalBubbleProps, ToolCallOutcome, ToolTier } from "./types";

import {
  DestructiveConfirmation,
  ProposalArguments,
  ProposalButtons,
  ProposalHeader,
} from "./proposal-bubble-parts";

function tierStyle(tier: ToolTier): React.CSSProperties {
  switch (tier) {
    case "mutation-destructive":
      return { borderColor: "var(--color-err)", color: "var(--color-err)" };
    case "mutation-dry-run-safe":
      return {
        borderColor: "var(--color-warn,var(--color-ok))",
        color: "var(--color-warn,var(--color-ok))",
      };
    case "read":
      return { borderColor: "var(--color-border)", color: "var(--color-text-secondary)" };
    default: {
      const _exhaustive: never = tier;
      return { borderColor: "var(--color-border)", color: "var(--color-text-secondary)" };
    }
  }
}

export function ProposalBubble({
  message,
  onApprove,
  onReject,
  onConfirmText,
}: ProposalBubbleProps): React.JSX.Element {
  const { step, tier, iteration, state, confirmText, previewOutcome, wetOutcome, reasoning } =
    message;
  const destructiveReady =
    tier === "mutation-destructive" ? confirmText.trim() === step.tool : true;
  const terminal = state === "done" || state === "failed" || state === "rejected";
  const running = state === "previewing" || state === "running-wet";

  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div
        style={{
          maxWidth: "85%",
          borderRadius: "1rem",
          border: "1px solid var(--color-border)",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          backgroundColor: "var(--color-surface-1)",
          ...tierStyle(tier),
        }}
        data-testid={`ops-chat-step-${String(iteration)}`}
        data-tier={tier}
        data-state={state}
      >
        <ProposalHeader
          reasoning={reasoning}
          iteration={iteration}
          terminal={terminal}
          tool={step.tool}
          tier={tier}
          tierStyle={tierStyle(tier)}
        />
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{step.annotation}</div>
        <ProposalArguments
          {...(step.args !== undefined ? { args: step.args } : {})}
          iteration={iteration}
        />

        {tier === "mutation-destructive" && !terminal && (
          <DestructiveConfirmation
            tool={step.tool}
            confirmText={confirmText}
            onConfirmText={onConfirmText}
            iteration={iteration}
          />
        )}

        {!terminal && (
          <ProposalButtons
            tier={tier}
            state={state}
            running={running}
            destructiveReady={destructiveReady}
            iteration={iteration}
            onApprove={onApprove}
            onReject={onReject}
          />
        )}

        {previewOutcome && (
          <OutcomePanel iteration={iteration} outcome={previewOutcome} kind="preview" />
        )}
        {wetOutcome && <OutcomePanel iteration={iteration} outcome={wetOutcome} kind="wet" />}
        {state === "rejected" && (
          <div
            style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
            data-testid={`ops-chat-step-${String(iteration)}-rejected`}
          >
            Operator rejected \u2014 session closed.
          </div>
        )}
      </div>
    </div>
  );
}

export function OutcomePanel({
  iteration,
  outcome,
  kind,
}: {
  iteration: number;
  outcome: ToolCallOutcome;
  kind: "preview" | "wet";
}): React.JSX.Element {
  return (
    <div
      style={{
        marginTop: 4,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-2)",
        padding: 8,
        fontSize: 11,
      }}
      data-testid={`ops-chat-step-${String(iteration)}-${kind === "preview" ? "preview-result" : "result"}`}
      data-ok={outcome.ok ? "true" : "false"}
    >
      <div style={{ color: "var(--color-text-secondary)" }}>
        {outcome.ok ? "✓ ok" : "✗ failed"} · {outcome.durationMs}ms
        {kind === "preview" ? " · dry-run" : ""}
      </div>
      {outcome.ok ? (
        <pre
          style={{
            marginTop: 4,
            maxHeight: 192,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            fontFamily: "var(--font-mono)",
          }}
        >
          {JSON.stringify(outcome.result, null, 2).slice(0, 2000)}
        </pre>
      ) : (
        <div style={{ color: "var(--color-err)" }}>
          {outcome.error?.code}: {outcome.error?.message}
        </div>
      )}
    </div>
  );
}
