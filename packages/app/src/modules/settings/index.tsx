import * as React from "react";

import { trpc } from "@/lib/trpc";

import { useSettingsStore } from "./project-scan-roots";
import { PromotionsEditor } from "./promotions-editor";
import { GROUPS } from "./types";

/**
 * Settings module — environment and preset control.
 */

export default function Settings(): React.JSX.Element {
  const env = trpc.env.useQuery();
  const { projectScanRootsText, setProjectScanRootsText } = useSettingsStore();

  if (env.isLoading) {
    return <div className="p-6 text-secondary">Loading…</div>;
  }
  const values = (env.data ?? {}) as Record<string, string>;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="settings-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-secondary">Settings</div>
      <h1 className="mb-2 text-2xl font-semibold text-primary">Environment</h1>
      <p className="mb-6 text-xs text-secondary">
        Read-only snapshot of the shell environment llamactl is running under.
      </p>

      <div className="flex flex-col gap-6">
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
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-tight text-secondary">
        Project scan roots
      </h2>
      <div className="p-3 border rounded bg-surface-1 border-border">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-secondary">
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
            className="w-full p-2 font-mono text-xs border rounded bg-surface-2 border-border text-primary resize-y"
          />
        </label>
        <div className="mt-2 text-xs text-secondary">
          One root per line or comma-separated. Leave empty for defaults.
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
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-tight text-secondary">
        {title}
      </h2>
      <div className="overflow-hidden border rounded border-border">
        <table className="w-full font-mono text-sm border-collapse">
          <tbody>
            {keys.map((key, idx) => {
              const raw = values[key];
              const isSet = raw !== undefined && raw !== "";
              return (
                <tr
                  key={key}
                  data-testid={`env-${key}`}
                  data-set={isSet ? "true" : "false"}
                  className={`bg-surface-1 ${idx === keys.length - 1 ? "" : "border-b border-border"}`}
                >
                  <td className="w-72 px-3 py-1.5 text-secondary">{key}</td>
                  <td
                    className={`px-3 py-1.5 break-all ${isSet ? "text-primary" : "text-secondary"}`}
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
