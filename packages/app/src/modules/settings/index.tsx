import * as React from "react";

import { trpc } from "@/lib/trpc";

import { useSettingsStore } from "./project-scan-roots";
import { PromotionsEditor } from "./promotions-editor";
import { GROUPS } from "./types";

/**
 * Settings module — environment and preset control.
 */

const sectionHeadingStyle: React.CSSProperties = {
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.025em",
  color: "var(--color-text-secondary)",
};

export default function Settings(): React.JSX.Element {
  const env = trpc.env.useQuery();
  const { projectScanRootsText, setProjectScanRootsText } = useSettingsStore();

  if (env.isLoading) {
    return <div style={{ padding: 24, color: "var(--color-text-secondary)" }}>Loading…</div>;
  }
  const values = (env.data ?? {}) as Record<string, string>;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="settings-root">
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Settings
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Environment
      </h1>
      <p style={{ marginBottom: 24, fontSize: 12, color: "var(--color-text-secondary)" }}>
        Read-only snapshot of the shell environment llamactl is running under. Values come from your
        shell (e.g. <span style={{ fontFamily: "var(--font-mono)" }}>LLAMA_CPP_MODELS</span>) and
        <span style={{ fontFamily: "var(--font-mono)" }}> ~/.llamactl/env</span>; rows marked
        <span style={{ color: "var(--color-text-secondary)" }}> unset</span> fall back to defaults.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <ProjectScanRootsSection
          text={projectScanRootsText}
          onChange={(v) => {
            setProjectScanRootsText(v);
          }}
        />

        {GROUPS.map((group) => (
          <EnvGroupSection
            key={group.title}
            title={group.title}
            keys={group.keys}
            values={values}
          />
        ))}

        <PromotionsEditor />
      </div>
    </div>
  );
}

function ProjectScanRootsSection({
  text,
  onChange,
}: {
  text: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  return (
    <section>
      <h2 style={sectionHeadingStyle}>Project scan roots</h2>
      <div
        style={{
          borderRadius: 6,
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-1)",
          padding: 12,
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span
            style={{
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--color-text-secondary)",
            }}
          >
            Roots
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              onChange(e.target.value);
            }}
            rows={7}
            spellCheck={false}
            placeholder="~/DevStorage/repos/personal&#10;~/DevStorage/repos/work"
            style={{
              width: "100%",
              borderRadius: 4,
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-2)",
              padding: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--color-text)",
              resize: "vertical",
            }}
          />
        </label>
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
          One root per line or comma-separated.{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>~</span> expands in the scanner. Leave
          empty to use the built-in defaults.
        </div>
      </div>
    </section>
  );
}

function EnvGroupSection({
  title,
  keys,
  values,
}: {
  title: string;
  keys: string[];
  values: Record<string, string>;
}): React.JSX.Element {
  return (
    <section>
      <h2 style={sectionHeadingStyle}>{title}</h2>
      <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
        <table
          style={{
            width: "100%",
            fontFamily: "var(--font-mono)",
            fontSize: 14,
            borderCollapse: "collapse",
          }}
        >
          <tbody>
            {keys.map((key, idx) => {
              const raw = values[key];
              const isSet = raw !== undefined && raw !== "";
              return (
                <tr
                  key={key}
                  data-testid={`env-${key}`}
                  data-set={isSet ? "true" : "false"}
                  style={{
                    borderBottom:
                      idx === keys.length - 1 ? "none" : "1px solid var(--color-border)",
                    background: "var(--color-surface-1)",
                  }}
                >
                  <td
                    style={{
                      width: 288,
                      padding: "6px 12px",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {key}
                  </td>
                  <td
                    style={
                      isSet
                        ? {
                            padding: "6px 12px",
                            color: "var(--color-text)",
                            wordBreak: "break-all",
                          }
                        : { padding: "6px 12px", color: "var(--color-text-secondary)" }
                    }
                  >
                    {isSet ? raw : "unset"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
