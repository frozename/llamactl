import * as React from "react";

import type { PlanResult, PlanStep } from "./types";

export function PlanCard({
  result,
  onApprove,
  onReject,
  decision,
  isLatest,
}: {
  result: PlanResult;
  onApprove: () => void;
  onReject: () => void;
  decision: "approved" | "rejected" | null;
  isLatest: boolean;
}): React.JSX.Element {
  if (!result.ok) {
    return <PlanFailureCard result={result} />;
  }

  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        padding: 12,
        fontSize: 14,
        marginTop: 8,
        background: "var(--color-surface-1)",
      }}
      data-testid="plan-result"
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontWeight: 500 }}>Plan</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
          executor={result.executor} · {result.plan.steps.length} step
          {result.plan.steps.length === 1 ? "" : "s"}
        </div>
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
        {result.plan.reasoning}
      </div>
      <PlanStepList steps={result.plan.steps} />
      {isLatest && (
        <PlanDecisionButtons decision={decision} onApprove={onApprove} onReject={onReject} />
      )}
    </div>
  );
}

function PlanFailureCard({
  result,
}: {
  result: Extract<PlanResult, { ok: false }>;
}): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "color:var(--color-warn,var(--color-ok))",
        padding: 12,
        fontSize: 14,
        marginTop: 4,
        background: "color:var(--color-surface-1)",
      }}
      data-testid="plan-failure"
    >
      <div style={{ fontWeight: 500 }}>Planner failed: {result.reason}</div>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{result.message}</div>
      {result.disallowedTools && result.disallowedTools.length > 0 && (
        <div style={{ fontSize: 12 }}>Disallowed tools: {result.disallowedTools.join(", ")}</div>
      )}
    </div>
  );
}

function PlanStepList({ steps }: { steps: PlanStep[] }): React.JSX.Element {
  return (
    <ol style={{ marginTop: 8 }} data-testid="plan-steps">
      {steps.map((step, i) => (
        <li
          key={i}
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderColor: "var(--color-border)",
            padding: 8,
            marginTop: 4,
          }}
          data-testid={`plan-step-${String(i)}`}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontFamily: "var(--font-mono)" }}>{i + 1}.</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>{step.tool}</span>
            {step.dryRun && (
              <span
                style={{
                  borderRadius: "var(--r-md)",
                  background: "var(--color-surface-2)",
                  fontSize: 10,
                  textTransform: "uppercase",
                }}
              >
                dry-run
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            {step.annotation}
          </div>
          {step.args && Object.keys(step.args).length > 0 && (
            <pre
              style={{
                fontSize: 11,
                background: "var(--color-surface-2)",
                borderRadius: "var(--r-md)",
                padding: 4,
                overflow: "auto",
              }}
            >
              {JSON.stringify(step.args, null, 2)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

function PlanDecisionButtons({
  decision,
  onApprove,
  onReject,
}: {
  decision: "approved" | "rejected" | null;
  onApprove: () => void;
  onReject: () => void;
}): React.JSX.Element {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <button
        type="button"
        onClick={onApprove}
        disabled={decision !== null}
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-border)",
          background: "var(--color-brand)",
          color: "var(--color-brand-contrast)",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 4,
          paddingBottom: 4,
          fontSize: 12,
          fontWeight: 500,
          opacity: decision ? 0.4 : 1,
        }}
        data-testid="plan-approve"
      >
        Approve
      </button>
      <button
        type="button"
        onClick={onReject}
        disabled={decision !== null}
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-border)",
          background: "var(--color-err)",
          color: "var(--color-text-inverse)",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 4,
          paddingBottom: 4,
          fontSize: 12,
          fontWeight: 500,
          opacity: decision ? 0.4 : 1,
        }}
        data-testid="plan-reject"
      >
        Reject
      </button>
      {decision && (
        <span
          style={{
            fontSize: 12,
            ...(decision === "approved"
              ? { color: "var(--color-ok)" }
              : { color: "var(--color-err)" }),
          }}
          data-testid="plan-decision"
        >
          {decision === "approved"
            ? 'Approved — run via llamactl plan run "<goal>" --auto'
            : "Rejected — refine and resend"}
        </span>
      )}
    </div>
  );
}
