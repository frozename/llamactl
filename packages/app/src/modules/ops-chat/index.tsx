import type { SafetyTier } from "@llamactl/core";

import * as React from "react";

import { OpsExecutorPicker } from "@/modules/ops/ops-executor-picker";

import { ProposalBubble } from "./proposal-bubble";
import { useOpsChat, type UseOpsChatReturn } from "./use-ops-chat";

/**
 * N.4 — Operator Console.
 */

interface AuditJournalEntry {
  ts: string;
  ok: boolean;
  tool: string;
  dryRun?: boolean;
  durationMs: number;
  errorCode?: string;
}

interface AuditTailData {
  path: string;
  entries: AuditJournalEntry[];
}

const CANNED_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: "Audit fleet health",
    prompt:
      "Check every node for unhealthy providers and suggest fixes. Read-only — do not apply anything yet.",
  },
  {
    label: "Today's AI spend",
    prompt: "Pull llamactl.cost.snapshot for today and summarize the top 3 spenders by provider.",
  },
  {
    label: "Promote top 3 models",
    prompt:
      "Using the bench results, promote the top 3 models by tokens/sec on macbook-pro-48g to the best/vision/balanced presets.",
  },
  {
    label: "List installed vision models",
    prompt: "List every vision-capable model installed on the control plane.",
  },
];

// eslint-disable-next-line react-refresh/only-export-components -- exported for catalog parity tests.
export const DEFAULT_CATALOG: {
  name: string;
  description: string;
  tier: SafetyTier;
}[] = [
  {
    name: "llamactl.catalog.list",
    description: "List curated models on the control plane.",
    tier: "read",
  },
  { name: "llamactl.node.ls", description: "List every cluster node.", tier: "read" },
  {
    name: "llamactl.bench.compare",
    description: "Joined catalog + bench comparison table.",
    tier: "read",
  },
  { name: "llamactl.bench.history", description: "Recent bench runs.", tier: "read" },
  { name: "llamactl.server.status", description: "llama-server lifecycle status.", tier: "read" },
  { name: "llamactl.workload.list", description: "Declarative ModelRun manifests.", tier: "read" },
  { name: "llamactl.promotions.list", description: "Current preset promotions.", tier: "read" },
  { name: "llamactl.env", description: "Environment snapshot.", tier: "read" },
  {
    name: "llamactl.cost.snapshot",
    description: "Rolled-up spend for the last N days.",
    tier: "read",
  },
  {
    name: "llamactl.catalog.promote",
    description: "Promote a model to a preset on a profile.",
    tier: "mutation-dry-run-safe",
  },
  {
    name: "llamactl.catalog.promoteDelete",
    description: "Remove a preset promotion.",
    tier: "mutation-destructive",
  },
  {
    name: "llamactl.workload.delete",
    description: "Remove a ModelRun manifest.",
    tier: "mutation-destructive",
  },
  {
    name: "llamactl.node.remove",
    description: "Remove a node from the cluster.",
    tier: "mutation-destructive",
  },
];

export default function OpsChat(): React.JSX.Element {
  const opsChat = useOpsChat(DEFAULT_CATALOG);
  const { messages, streaming } = opsChat;

  return (
    <div
      style={{ display: "flex", height: "100%", flexDirection: "column" }}
      data-testid="ops-chat-root"
      data-streaming={streaming ? "true" : "false"}
      data-message-count={messages.length}
    >
      <ChatHeader opsChat={opsChat} />
      <ChatTranscript opsChat={opsChat} />
      <AuditLog opsChat={opsChat} />
      <ChatInput opsChat={opsChat} />
    </div>
  );
}

function ChatHeader({ opsChat }: { opsChat: UseOpsChatReturn }): React.JSX.Element {
  const { messages, onReset, auditTail } = opsChat;
  const data = auditTail.data as AuditTailData | undefined;
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
          <h2 style={{ fontSize: 18, fontWeight: 500 }}>Operator Console</h2>
          <p style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>
            Natural-language goals become MCP tool calls. Reads run with one click; mutations
            preview dry-first; destructive actions require the operator to type the tool name to
            confirm. Every attempt — dry, wet, successful, failed — appends one entry to
            {data?.path ? (
              <span style={{ fontFamily: "var(--font-mono)" }}> {data.path}</span>
            ) : (
              <span> the ops-chat audit journal</span>
            )}
            .
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <OpsExecutorPicker />
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => {
                onReset();
              }}
              data-testid="ops-chat-reset"
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

function ChatTranscript({ opsChat }: { opsChat: UseOpsChatReturn }): React.JSX.Element {
  const { messages, scrollRef, streaming, error, onApprove, onReject, onConfirmText } = opsChat;
  return (
    <div
      ref={scrollRef}
      style={{ flex: 1, overflow: "auto", padding: 16, marginTop: 12 }}
      data-testid="ops-chat-transcript"
    >
      {messages.length === 0 && (
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
          data-testid="ops-chat-empty"
        >
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--color-text)" }}>
            Drive the fleet by describing the goal
          </h3>
          <p style={{ marginTop: 4, fontSize: 12 }}>
            Example:{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>list installed vision models</span>.
            The planner proposes tool calls one at a time, inline. Approve each one; reads run with
            a click, mutations preview dry-first.
          </p>
        </div>
      )}
      {messages.map((msg) => {
        if (msg.kind === "user") {
          return <UserMessage key={msg.id} content={msg.content} />;
        }
        if (msg.kind === "refusal") {
          return <RefusalMessage key={msg.id} id={msg.id} reason={msg.reason} />;
        }
        if (msg.kind === "done") {
          return <DoneMessage key={msg.id} id={msg.id} iterations={msg.iterations} />;
        }
        return (
          <ProposalBubble
            key={msg.id}
            message={msg}
            onApprove={(dryRun) => {
              void onApprove(msg, dryRun);
            }}
            onReject={() => {
              void onReject(msg);
            }}
            onConfirmText={(v) => {
              onConfirmText(msg.id, v);
            }}
          />
        );
      })}
      {streaming && !messages.some((m) => m.kind === "proposal" && m.state === "pending") && (
        <PlanningIndicator />
      )}
      {error && <ErrorMessage error={error} />}
    </div>
  );
}

function UserMessage({ content }: { content: string }): React.JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
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
        {content}
      </div>
    </div>
  );
}

function RefusalMessage({ id, reason }: { id: number; reason: string }): React.JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-warn,var(--color-ok))",
          padding: 12,
          fontSize: 14,
          marginTop: 4,
          background: "color:var(--color-surface-1)",
        }}
        data-testid={`ops-chat-refusal-${String(id)}`}
      >
        <div style={{ fontWeight: 500 }}>Planner refused</div>
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>{reason}</div>
      </div>
    </div>
  );
}

function DoneMessage({ id, iterations }: { id: number; iterations: number }): React.JSX.Element {
  return (
    <div
      style={{ display: "flex", justifyContent: "center" }}
      data-testid={`ops-chat-done-${String(id)}`}
    >
      <div
        style={{
          background: "color:var(--color-surface-2)",
          paddingLeft: 12,
          paddingRight: 12,
          paddingTop: 4,
          paddingBottom: 4,
          fontSize: 10,
          color: "var(--color-text-secondary)",
        }}
      >
        Loop closed · {iterations} iteration{iterations === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function PlanningIndicator(): React.JSX.Element {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }} data-testid="ops-chat-pending">
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
  );
}

function ErrorMessage({ error }: { error: string }): React.JSX.Element {
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
      data-testid="ops-chat-error"
    >
      {error}
    </div>
  );
}

function AuditLog({ opsChat }: { opsChat: UseOpsChatReturn }): React.JSX.Element {
  const { auditTail } = opsChat;
  const data = auditTail.data as AuditTailData | undefined;
  const entries = data?.entries;
  return (
    <details
      style={{
        borderTop: "1px solid var(--color-border)",
        borderColor: "color:var(--color-border)",
        background: "color:var(--color-surface-1)",
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 12,
      }}
      data-testid="ops-chat-audit-details"
    >
      <summary style={{ cursor: "pointer", color: "var(--color-text-secondary)" }}>
        Audit ({entries?.length ?? 0})
      </summary>
      {entries && entries.length > 0 ? (
        <ul
          style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10 }}
          data-testid="ops-chat-audit-list"
        >
          {entries.slice(0, 20).map((entry, i) => (
            <AuditEntry key={`${entry.ts}-${String(i)}`} entry={entry} i={i} />
          ))}
        </ul>
      ) : (
        <p style={{ marginTop: 8, color: "var(--color-text-secondary)" }}>
          No audit entries yet — run a step to start populating{" "}
          {data?.path ? (
            <span style={{ fontFamily: "var(--font-mono)" }}>{data.path}</span>
          ) : (
            <span>the ops-chat audit journal</span>
          )}
          .
        </p>
      )}
    </details>
  );
}

function AuditEntry({ entry, i }: { entry: AuditJournalEntry; i: number }): React.JSX.Element {
  return (
    <li
      data-testid={`ops-chat-audit-entry-${String(i)}`}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        color: "var(--color-text-secondary)",
      }}
    >
      <span>{entry.ts.slice(11, 19)}</span>
      <span
        style={{
          ...(entry.ok ? { color: "var(--color-ok)" } : { color: "var(--color-err)" }),
        }}
      >
        {entry.ok ? "✓" : "✗"}
      </span>
      <span style={{ color: "var(--color-text)" }}>{entry.tool}</span>
      {entry.dryRun && (
        <span
          style={{
            borderRadius: "var(--r-md)",
            background: "color:var(--color-surface-2)",
          }}
        >
          dry
        </span>
      )}
      <span>{entry.durationMs}ms</span>
      {!entry.ok && entry.errorCode && (
        <span style={{ color: "var(--color-err)" }}>{entry.errorCode}</span>
      )}
    </li>
  );
}

function ChatInput({ opsChat }: { opsChat: UseOpsChatReturn }): React.JSX.Element {
  const { draft, setDraft, streaming, messages, onSubmit } = opsChat;
  const submitDisabled = streaming || draft.trim().length === 0;

  return (
    <div
      style={{
        borderTop: "1px solid var(--color-border)",
        borderColor: "color:var(--color-border)",
        padding: 12,
        marginTop: 8,
      }}
    >
      <div
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 4 }}
        data-testid="ops-chat-canned-prompts"
      >
        {CANNED_PROMPTS.map((cp, i) => (
          <button
            key={cp.label}
            type="button"
            onClick={() => {
              setDraft(cp.prompt);
            }}
            disabled={streaming}
            data-testid={`ops-chat-canned-${String(i)}`}
            style={{
              borderRadius: 9999,
              border: "1px solid var(--color-border)",
              borderColor: "color:var(--color-border)",
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
            {cp.label}
          </button>
        ))}
      </div>
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
        rows={2}
        placeholder={
          messages.length === 0
            ? "e.g. list installed vision models"
            : streaming
              ? "Waiting for next proposal…"
              : 'Start a new conversation by clicking "New conversation"'
        }
        disabled={streaming}
        style={{
          width: "100%",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "color:var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 8,
          fontSize: 14,
          fontFamily: "var(--font-mono)",
          opacity: 0.5,
        }}
        data-testid="ops-chat-goal"
      />
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <button
          type="button"
          onClick={onSubmit}
          disabled={submitDisabled}
          data-testid="ops-chat-submit"
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
            cursor: "not-allowed",
            opacity: 0.5,
          }}
        >
          {streaming ? "Streaming…" : messages.length === 0 ? "Plan" : "Send"}
        </button>
        <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
          ⌘/Ctrl+Enter to send · {messages.length} message{messages.length === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );
}
