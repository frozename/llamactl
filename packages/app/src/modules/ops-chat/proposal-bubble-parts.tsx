import * as React from "react";

import type { ProposalState, ToolTier } from "./types";

export function ProposalHeader({
  reasoning,
  iteration,
  terminal,
  tool,
  tier,
  tierStyle,
}: {
  reasoning: string;
  iteration: number;
  terminal: boolean;
  tool: string;
  tier: ToolTier;
  tierStyle: React.CSSProperties;
}): React.JSX.Element {
  return (
    <>
      {reasoning.length > 0 && (
        <p
          style={{ fontSize: 12, color: "var(--color-text-secondary)" }}
          data-testid={`ops-chat-step-${String(iteration)}-reasoning`}
        >
          {reasoning}
        </p>
      )}
      <div style={{ fontSize: 14, color: "var(--color-text)" }}>
        {terminal ? "Ran:" : "I\u2019d like to run:"}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>{tool}</span>
        <span
          style={{
            borderRadius: "0.25rem",
            border: "1px solid var(--color-border)",
            paddingLeft: 4,
            paddingRight: 4,
            fontSize: 10,
            ...tierStyle,
          }}
          data-testid={`ops-chat-step-${String(iteration)}-tier`}
        >
          {tier}
        </span>
      </div>
    </>
  );
}

export function ProposalArguments({
  args,
  iteration,
}: {
  args?: Record<string, unknown>;
  iteration: number;
}): React.JSX.Element | null {
  if (!args || Object.keys(args).length === 0) return null;
  return (
    <pre
      style={{
        fontSize: 11,
        background: "var(--color-surface-2)",
        borderRadius: "var(--r-md)",
        padding: 4,
        overflow: "auto",
      }}
      data-testid={`ops-chat-step-${String(iteration)}-args`}
    >
      {JSON.stringify(args, null, 2)}
    </pre>
  );
}

export function DestructiveConfirmation({
  tool,
  confirmText,
  onConfirmText,
  iteration,
}: {
  tool: string;
  confirmText: string;
  onConfirmText: (v: string) => void;
  iteration: number;
}): React.JSX.Element {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 10,
        color: "var(--color-text-secondary)",
      }}
    >
      Type <span style={{ fontFamily: "var(--font-mono)" }}>{tool}</span> to unlock:
      <input
        type="text"
        value={confirmText}
        onChange={(e) => {
          onConfirmText(e.target.value);
        }}
        data-testid={`ops-chat-step-${String(iteration)}-confirm`}
        style={{
          width: 192,
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          paddingTop: 2,
          paddingBottom: 2,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
        }}
      />
    </label>
  );
}

export function ProposalButtons({
  tier,
  state,
  running,
  destructiveReady,
  iteration,
  onApprove,
  onReject,
}: {
  tier: ToolTier;
  state: ProposalState;
  running: boolean;
  destructiveReady: boolean;
  iteration: number;
  onApprove: (dryRun: boolean) => void;
  onReject: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      {tier !== "read" && (
        <button
          type="button"
          onClick={() => {
            onApprove(true);
          }}
          disabled={running || state === "preview-ready"}
          data-testid={`ops-chat-step-${String(iteration)}-preview`}
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            paddingLeft: 8,
            paddingRight: 8,
            paddingTop: 2,
            paddingBottom: 2,
            fontSize: 10,
            color: "var(--color-text-secondary)",
            opacity: 0.5,
          }}
        >
          {state === "previewing" ? "Running…" : "Preview (dry)"}
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onApprove(false);
        }}
        disabled={running || (tier === "mutation-destructive" && !destructiveReady)}
        data-testid={`ops-chat-step-${String(iteration)}-run`}
        className={
          tier === "mutation-destructive"
            ? "rounded border border-[var(--color-err)] px-2 py-0.5 text-[10px] text-[color:var(--color-err)] disabled:opacity-40"
            : tier === "mutation-dry-run-safe"
              ? "rounded border border-[var(--color-brand)] px-2 py-0.5 text-[10px] text-[color:var(--color-brand)] disabled:opacity-40"
              : "rounded border border-[var(--color-border)] bg-[var(--color-brand)] px-2 py-0.5 text-[10px] text-[color:var(--color-brand-contrast)] disabled:opacity-40"
        }
      >
        {state === "running-wet" ? "Running…" : tier === "read" ? "Run" : "Run (wet)"}
      </button>
      <button
        type="button"
        onClick={onReject}
        disabled={running}
        data-testid={`ops-chat-step-${String(iteration)}-reject`}
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 2,
          paddingBottom: 2,
          fontSize: 10,
          color: "var(--color-text-secondary)",
          opacity: 0.5,
        }}
      >
        Reject
      </button>
    </div>
  );
}
