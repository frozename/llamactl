import * as React from "react";

import { OpsExecutorPicker } from "@/modules/ops/ops-executor-picker";

import type { ToolCatalogEntry, Turn } from "./types";

import { PlanCard } from "./plan-card";
import { usePlan, type UsePlanReturn } from "./use-plan";

/**
 * N.4.5 — operator-plan chat UI.
 */

const DEFAULT_CATALOG: ToolCatalogEntry[] = [
  {
    name: "nova.ops.overview",
    description: "Unified fleet snapshot — agents, gateways, providers.",
    tier: "read",
  },
  {
    name: "nova.ops.cost.snapshot",
    description: "Rolled-up spend for the last N days.",
    tier: "read",
  },
  {
    name: "llamactl.catalog.list",
    description: "List curated models on the target node.",
    tier: "read",
  },
  {
    name: "llamactl.catalog.promote",
    description: "Promote a model to a preset on a node.",
    tier: "mutation-dry-run-safe",
  },
  {
    name: "llamactl.bench.compare",
    description: "Compare benchmarked models by class + scope.",
    tier: "read",
  },
  {
    name: "llamactl.embersynth.sync",
    description: "Regenerate embersynth.yaml from current state.",
    tier: "mutation-dry-run-safe",
  },
  {
    name: "llamactl.embersynth.set-default-profile",
    description: "Remap a synthetic model to a different profile.",
    tier: "mutation-dry-run-safe",
  },
];

function tierClass(tier: ToolCatalogEntry["tier"]): string {
  switch (tier) {
    case "read":
      return "bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]";
    case "mutation-destructive":
      return "bg-[var(--color-err)] text-[color:var(--color-text-inverse)]";
    case "mutation-dry-run-safe":
      return "bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]";
    default:
      return "bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]";
  }
}

export default function Plan(): React.JSX.Element {
  const planObj = usePlan(DEFAULT_CATALOG);

  return (
    <div
      style={{ display: "flex", height: "100%", flexDirection: "column" }}
      data-testid="plan-root"
    >
      <PlanHeader planObj={planObj} />
      <PlanTranscript planObj={planObj} />
      <PlanInput planObj={planObj} />
      <ToolCatalogDetails planObj={planObj} />
    </div>
  );
}

function PlanHeader({ planObj }: { planObj: UsePlanReturn }): React.JSX.Element {
  const { turns, onReset } = planObj;
  return (
    <div
      style={{
        borderBottom: "1px solid var(--color-border)",
        borderColor: "color:var(--color-border)",
        padding: 16,
        marginTop: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Operator plan</h2>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Describe an operational goal. Each reply is a validated plan you can approve or refine
            in a follow-up turn.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <OpsExecutorPicker />
          {turns.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onReset();
              }}
              data-testid="plan-reset"
              style={{
                borderRadius: "var(--r-md)",
                border: "1px solid var(--color-border)",
                borderColor: "color:var(--color-border)",
                background: "color:var(--color-surface-2)",
                paddingLeft: 12,
                paddingRight: 12,
                paddingTop: 4,
                paddingBottom: 4,
                fontSize: 12,
                color: "var(--color-text-secondary)",
              }}
            >
              New conversation
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function PlanTranscript({ planObj }: { planObj: UsePlanReturn }): React.JSX.Element {
  const { turns, scrollRef, plan, error, setDecision, decision, latestAssistantId } = planObj;
  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, overflow: "auto", padding: 16, marginTop: 12 }}
      data-testid="plan-transcript"
    >
      {turns.length === 0 && (
        <div
          style={{
            borderRadius: "var(--r-md)",
            border: "1px solid var(--color-border)",
            borderStyle: "dashed",
            borderColor: "color:var(--color-border)",
            padding: 24,
            fontSize: 14,
            color: "var(--color-text-secondary)",
          }}
          data-testid="plan-empty"
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
            Start with a goal
          </h3>
          <p style={{ marginTop: 4, fontSize: 12 }}>
            Example:{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>
              promote the fastest vision model on macbook-pro-48g
            </span>
            . The planner returns a step-by-step plan — you can then ask for refinements in the same
            conversation.
          </p>
        </div>
      )}
      {turns.map((turn: Turn) => {
        if (turn.role === "user") {
          return <UserTurn key={turn.id} turn={turn} />;
        }
        return (
          <div
            key={turn.id}
            style={{ display: "flex", justifyContent: "flex-start" }}
            data-testid={`plan-turn-assistant-${String(turn.id)}`}
          >
            <div style={{ width: "100%" }}>
              <PlanCard
                result={turn.result}
                onApprove={() => {
                  setDecision("approved");
                }}
                onReject={() => {
                  setDecision("rejected");
                }}
                decision={turn.id === latestAssistantId ? decision : null}
                isLatest={turn.id === latestAssistantId}
              />
            </div>
          </div>
        );
      })}
      {plan.isPending && (
        <div style={{ display: "flex", justifyContent: "flex-start" }} data-testid="plan-pending">
          <div
            style={{
              background: "color:var(--color-surface-2)",
              paddingLeft: 12,
              paddingRight: 12,
              paddingTop: 8,
              paddingBottom: 8,
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            Planning…
          </div>
        </div>
      )}
      {error && <PlanError error={error} />}
    </div>
  );
}

function UserTurn({ turn }: { turn: Extract<Turn, { role: "user" }> }): React.JSX.Element {
  return (
    <div
      style={{ display: "flex", justifyContent: "flex-end" }}
      data-testid={`plan-turn-user-${String(turn.id)}`}
    >
      <div
        style={{
          background: "color:var(--color-ok)",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 8,
          paddingBottom: 8,
          fontSize: 14,
          color: "var(--color-text-inverse)",
          whiteSpace: "pre-wrap",
        }}
      >
        {turn.text}
      </div>
    </div>
  );
}

function PlanError({ error }: { error: string }): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "color:var(--color-err)",
        background: "color:var(--color-surface-1)",
        padding: 8,
        fontSize: 12,
        color: "var(--color-err)",
      }}
      data-testid="plan-error"
    >
      {error}
    </div>
  );
}

function PlanInput({ planObj }: { planObj: UsePlanReturn }): React.JSX.Element {
  const { draft, setDraft, onSubmit, plan, turns } = planObj;
  const submitDisabled = plan.isPending || draft.trim().length === 0;

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        borderColor: "color:var(--color-border)",
        padding: 12,
        marginTop: 8,
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          }
        }}
        rows={3}
        placeholder={
          turns.length === 0
            ? "e.g. promote the fastest vision model on macbook-pro-48g"
            : 'Refine: "change step 3 to target gpu1", "add a rollback", "why did you skip nova.ops.overview?"'
        }
        style={{
          width: "100%",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 8,
          fontSize: 14,
          fontFamily: "var(--font-mono)",
        }}
        data-testid="plan-goal"
      />
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <button
          type="button"
          onClick={() => {
            onSubmit();
          }}
          disabled={submitDisabled}
          data-testid="plan-submit"
          title={submitDisabled ? "Type a goal, then send" : "Send (⌘/Ctrl+Enter)"}
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
            fontSize: 14,
            fontWeight: 500,
            opacity: submitDisabled ? 0.4 : 1,
            cursor: submitDisabled ? "not-allowed" : "pointer",
          }}
        >
          {plan.isPending ? "Planning…" : turns.length === 0 ? "Generate plan" : "Send"}
        </button>
        <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
          ⌘/Ctrl+Enter to send · {turns.length} turn{turns.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}

function ToolCatalogDetails({ planObj }: { planObj: UsePlanReturn }): React.JSX.Element {
  const { catalog, setCatalog } = planObj;
  return (
    <details
      style={{
        borderTop: "1px solid var(--color-border)",
        borderColor: "color:var(--color-border)",
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
      }}
    >
      <summary style={{ cursor: "pointer" }}>Tool catalog ({catalog.length})</summary>
      <ul style={{ marginTop: 4 }}>
        {catalog.map((t) => (
          <li key={t.name} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className={`px-1 rounded text-[10px] ${tierClass(t.tier)}`}>{t.tier}</span>
            <span style={{ fontFamily: "var(--font-mono)" }}>{t.name}</span>
            <span style={{ color: "var(--color-text-secondary)" }}>—</span>
            <span style={{ color: "var(--color-text-secondary)" }}>{t.description}</span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          setCatalog(DEFAULT_CATALOG);
        }}
        style={{
          marginTop: 8,
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-border)",
          background: "var(--color-surface-2)",
          paddingLeft: 8,
          paddingRight: 8,
          paddingTop: 4,
          paddingBottom: 4,
          fontSize: 11,
        }}
        data-testid="plan-reset-catalog"
      >
        Reset to defaults
      </button>
    </details>
  );
}
