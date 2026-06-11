import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, EditorialHero, Input } from "@/ui";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return i === 0 ? `${String(Math.trunc(x))} B` : `${x.toFixed(1)} ${String(units[i])}`;
}

interface ImportItem {
  action: string;
  rel: string;
  source: { path: string; sizeBytes: number };
  targetPath: string;
}

function ImportForm(props: {
  root: string | undefined;
  defaultRoot: string | undefined;
  busy: boolean;
  actionableCount: number;
  onImport: (rootOverride: string, link: boolean) => void;
}): React.JSX.Element {
  const [rootOverride, setRootOverride] = useState("");
  const [link, setLink] = useState(true);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      style={{
        marginBottom: 16,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
        <label style={{ gridColumn: "span 7" }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            Root override
          </span>
          <Input
            value={rootOverride}
            onChange={(e) => {
              setRootOverride(e.target.value);
            }}
            placeholder={props.root ?? props.defaultRoot ?? ""}
            disabled={props.busy}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
        </label>
        <label
          style={{
            gridColumn: "span 2",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            fontSize: 12,
          }}
        >
          <span style={{ marginBottom: 4 }}>Link</span>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input
              type="checkbox"
              checked={link}
              onChange={(e) => {
                setLink(e.target.checked);
              }}
              disabled={props.busy}
            />
            <span>symlink</span>
          </label>
        </label>
        <div style={{ gridColumn: "span 3", display: "flex", alignItems: "flex-end" }}>
          <Button
            variant="primary"
            onClick={() => {
              props.onImport(rootOverride, link);
            }}
            disabled={props.busy || props.actionableCount === 0}
            style={{ width: "100%" }}
          >
            {props.busy ? "Importing…" : `Import ${String(props.actionableCount)}`}
          </Button>
        </div>
      </div>
    </form>
  );
}

function CandidatesTable({ items }: { items: ImportItem[] }): React.JSX.Element {
  return (
    <div style={{ overflow: "hidden", borderRadius: 6, border: "1px solid var(--color-border)" }}>
      <table style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}>
        <thead style={{ backgroundColor: "var(--color-surface-1)", textAlign: "left" }}>
          <tr>
            <th style={{ padding: "8px 12px" }}>Action</th>
            <th style={{ padding: "8px 12px" }}>Rel</th>
            <th style={{ padding: "8px 12px" }}>Size</th>
            <th style={{ padding: "8px 12px" }}>Target</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.source.path}
              style={{
                borderTop: "1px solid var(--color-border)",
                backgroundColor: "var(--color-surface-1)",
              }}
            >
              <td style={{ padding: "6px 12px" }}>
                <span
                  style={{
                    color: item.action.startsWith("skip")
                      ? "var(--color-text-secondary)"
                      : "var(--color-ok)",
                  }}
                >
                  {item.action}
                </span>
              </td>
              <td
                style={{ padding: "6px 12px", color: "var(--color-brand)", wordBreak: "break-all" }}
              >
                {item.rel}
              </td>
              <td style={{ padding: "6px 12px" }}>{formatBytes(item.source.sizeBytes)}</td>
              <td
                style={{
                  padding: "6px 12px",
                  color: "var(--color-text-secondary)",
                  wordBreak: "break-all",
                }}
              >
                {item.targetPath}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LMStudio(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [rootOverride, setRootOverride] = useState("");
  const [link, setLink] = useState(true);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const plan = trpc.lmstudioPlan.useQuery(
    rootOverride.trim() ? { root: rootOverride.trim(), link } : { link },
  );
  const importMut = trpc.lmstudioImport.useMutation({
    onSuccess: async (res) => {
      setReport(
        `root=${res.root ?? "unknown"} applied=${String(res.applied.length)} skipped=${String(res.skipped.length)} errors=${String(res.errors.length)}`,
      );
      setError(null);
      await queryClient.invalidateQueries({ queryKey: [["lmstudioPlan"]] });
      await queryClient.invalidateQueries({ queryKey: [["catalogList"]] });
    },
    onError: (err) => {
      setError(err.message);
      setReport(null);
    },
  });

  const items = (plan.data?.items ?? []) as ImportItem[];
  const actionableCount = items.filter(
    (i) => i.action === "link-and-add" || i.action === "add",
  ).length;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }}>
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          color: "var(--color-text-secondary)",
        }}
      >
        LM Studio
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600 }}>Import models</h1>
      <ImportForm
        root={plan.data?.root ?? undefined}
        defaultRoot={plan.data?.defaultRoot ?? undefined}
        busy={importMut.isPending}
        actionableCount={actionableCount}
        onImport={(r, l) => {
          setRootOverride(r);
          setLink(l);
          importMut.mutate({ root: r.trim() || undefined, link: l });
        }}
      />
      {error && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-err)",
            padding: "8px 12px",
            color: "var(--color-err)",
          }}
        >
          {error}
        </div>
      )}
      {report && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-ok)",
            padding: "8px 12px",
            color: "var(--color-ok)",
          }}
        >
          {report}
        </div>
      )}
      <section>
        <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600 }}>
          Candidates ({String(items.length)}){plan.data?.root ? ` — ${plan.data.root}` : ""}
        </h2>
        {plan.isLoading ? (
          <div>Scanning…</div>
        ) : !plan.data?.root ? (
          <EditorialHero title="No install detected" lede="Set LMSTUDIO_MODELS_DIR." />
        ) : items.length === 0 ? (
          <EditorialHero title="No models found" lede="Check directory." />
        ) : (
          <CandidatesTable items={items} />
        )}
      </section>
    </div>
  );
}
