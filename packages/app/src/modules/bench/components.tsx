import * as React from "react";

import { EditorialHero } from "@/ui";

import type { LogLine } from "./types";

export function LogPanel(props: {
  log: LogLine[];
  busy: boolean;
  logRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const { log, busy, logRef } = props;
  return (
    <div
      style={{
        marginBottom: 24,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-0)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          color: "var(--color-text-secondary)",
        }}
      >
        <span>Log</span>
        <span>
          {log.length} line{log.length === 1 ? "" : "s"}
        </span>
      </div>
      <div
        ref={logRef}
        style={{
          maxHeight: "40vh",
          overflow: "auto",
          borderTop: "1px solid var(--color-border)",
          padding: "8px 12px",
          fontFamily: "monospace",
          fontSize: 12,
        }}
      >
        {log.length === 0 ? (
          <div style={{ color: "var(--color-text-secondary)" }}>
            {busy ? "Waiting for output…" : "Run preset or vision to see streaming output here."}
          </div>
        ) : (
          log.map((line, i) => {
            let color = "var(--color-text)";
            if (line.kind === "stderr" || line.kind === "error") color = "var(--color-warn)";
            else if (line.kind === "done") color = "var(--color-ok)";
            else if (line.kind === "start" || line.kind === "profile") color = "var(--color-brand)";

            return (
              <div key={i} style={{ color, whiteSpace: "pre-wrap" }}>
                {line.text}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function fmtTps(raw: string | number | undefined | null): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  const n = typeof raw === "number" ? raw : Number.parseFloat(raw);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

interface HistoryRow {
  updated_at: string;
  rel: string;
  mode: string;
  profile: string;
  gen_ts: string | number;
  prompt_ts: string | number;
  build: string;
}

export function HistoryTable(props: { recentHistory: HistoryRow[] }): React.JSX.Element {
  const { recentHistory } = props;
  if (recentHistory.length === 0) {
    return (
      <EditorialHero
        title="No benchmark history recorded yet"
        lede="Run a benchmark to see the history here."
      />
    );
  }
  return (
    <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
      <table style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}>
        <thead
          style={{
            backgroundColor: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Updated</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Rel</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Mode</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Profile</th>
            <th style={{ padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>Gen tps</th>
            <th style={{ padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>Prompt tps</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Build</th>
          </tr>
        </thead>
        <tbody>
          {recentHistory
            .slice()
            .reverse()
            .slice(0, 30)
            .map((row, i) => (
              <tr
                key={`${row.updated_at}-${String(i)}`}
                style={{
                  borderTop: "1px solid var(--color-border)",
                  backgroundColor: "var(--color-surface-1)",
                }}
              >
                <td style={{ padding: "6px 12px", color: "var(--color-text-secondary)" }}>
                  {row.updated_at}
                </td>
                <td
                  style={{
                    padding: "6px 12px",
                    color: "var(--color-brand)",
                    wordBreak: "break-all",
                  }}
                >
                  {row.rel}
                </td>
                <td style={{ padding: "6px 12px" }}>{row.mode}</td>
                <td style={{ padding: "6px 12px" }}>{row.profile}</td>
                <td style={{ padding: "6px 12px", textAlign: "right", color: "var(--color-ok)" }}>
                  {fmtTps(row.gen_ts)}
                </td>
                <td style={{ padding: "6px 12px", textAlign: "right" }}>{fmtTps(row.prompt_ts)}</td>
                <td style={{ padding: "6px 12px", color: "var(--color-text-secondary)" }}>
                  {row.build}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
