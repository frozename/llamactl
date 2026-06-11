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
  rootOverride: string;
  setRootOverride: (v: string) => void;
  link: boolean;
  setLink: (v: boolean) => void;
  onImport: () => void;
}): React.JSX.Element {
  const { busy, actionableCount, rootOverride, setRootOverride, link, setLink } = props;
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
        <label style={{ gridColumn: "span 7 / span 7", fontSize: 14 }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            Root (optional override)
          </span>
          <Input
            value={rootOverride}
            onChange={(e) => {
              setRootOverride(e.target.value);
            }}
            placeholder={props.root ?? props.defaultRoot ?? ""}
            disabled={busy}
            style={{ width: "100%", fontFamily: "monospace" }}
          />
        </label>
        <label
          style={{
            gridColumn: "span 2 / span 2",
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            fontSize: 12,
            color: "var(--color-text-secondary)",
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
              disabled={busy}
            />
            <span>symlink into $LLAMA_CPP_MODELS</span>
          </label>
        </label>
        <div style={{ gridColumn: "span 3 / span 3", display: "flex", alignItems: "flex-end" }}>
          <Button
            variant="primary"
            onClick={() => {
              props.onImport();
            }}
            disabled={busy || actionableCount === 0}
            data-testid="lmstudio-import"
            style={{ width: "100%" }}
            title={
              actionableCount === 0
                ? "No candidates ready to import — scan a root with .gguf files first."
                : `Import ${String(actionableCount)} candidate${actionableCount === 1 ? "" : "s"} into $LLAMA_CPP_MODELS.`
            }
          >
            {busy
              ? "Importing…"
              : actionableCount === 0
                ? "Nothing to import"
                : `Import ${String(actionableCount)}`}
          </Button>
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
        When link is on, each candidate becomes a symlink at $LLAMA_CPP_MODELS/&lt;rel&gt; so
        llamactl reads find it without copying gigabytes.
      </div>
    </form>
  );
}

function CandidatesTable({ items }: { items: ImportItem[] }): React.JSX.Element {
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
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Action</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Rel</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Size</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Target</th>
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
              <td style={{ padding: "6px 12px", color: "var(--color-text-secondary)" }}>
                {formatBytes(item.source.sizeBytes)}
              </td>
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

function ResultBanner({
  tone,
  children,
}: {
  tone: "ok" | "err";
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        marginBottom: 12,
        borderRadius: 6,
        border: `1px solid var(--color-${tone})`,
        backgroundColor: "var(--color-surface-1)",
        padding: "8px 12px",
        fontSize: 14,
        color: `var(--color-${tone})`,
      }}
    >
      {children}
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
  const root = plan.data?.root ?? undefined;
  const actionableCount = items.filter(
    (i) => i.action === "link-and-add" || i.action === "add",
  ).length;

  return (
    <div
      style={{ height: "100%", overflow: "auto", padding: 24 }}
      data-testid="models-lmstudio-root"
    >
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        LM Studio
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Import models
      </h1>
      <ImportForm
        root={root}
        defaultRoot={plan.data?.defaultRoot ?? undefined}
        busy={importMut.isPending}
        actionableCount={actionableCount}
        rootOverride={rootOverride}
        setRootOverride={setRootOverride}
        link={link}
        setLink={setLink}
        onImport={() => {
          importMut.mutate({ root: rootOverride.trim() || undefined, link });
        }}
      />
      {error && <ResultBanner tone="err">{error}</ResultBanner>}
      {report && <ResultBanner tone="ok">{report}</ResultBanner>}
      <section>
        <h2
          style={{
            marginBottom: 8,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Candidates ({items.length}){root ? ` — ${root}` : ""}
        </h2>
        {plan.isLoading ? (
          <div style={{ color: "var(--color-text-secondary)" }}>Scanning…</div>
        ) : !root ? (
          <EditorialHero
            title="No LM Studio install detected"
            lede="Set LMSTUDIO_MODELS_DIR or supply a root override above."
          />
        ) : items.length === 0 ? (
          <EditorialHero
            title={`No .gguf files found under ${root}`}
            lede="Ensure the directory exists and contains valid model files."
          />
        ) : (
          <CandidatesTable items={items} />
        )}
      </section>
    </div>
  );
}
