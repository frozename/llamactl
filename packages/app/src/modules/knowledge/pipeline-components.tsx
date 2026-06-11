import * as React from "react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";

export interface PipelineManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    destination: { ragNode: string; collection: string };
    sources: ({ kind: string } & Record<string, unknown>)[];
    schedule?: string;
    on_duplicate?: "skip" | "replace" | "version";
  };
}

export interface PipelineRecord {
  name: string;
  manifest: PipelineManifest;
  lastRun?: {
    at: string;
    summary: {
      total_docs: number;
      total_chunks: number;
      skipped_docs: number;
      errors: number;
      elapsed_ms: number;
      estimated_cost?: { usd: number; currency: string; source: string };
    };
  };
}

export interface RunningEntry {
  name: string;
  startedAt: string;
  sources: string[];
  stale?: boolean;
}

function formatElapsed(startIso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  return `${String(m)}m${String(s % 60)}s`;
}

export function RunningBadge({ entry }: { entry: RunningEntry }): React.JSX.Element {
  const [now, setNow] = useState<number>(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return (): void => {
      clearInterval(id);
    };
  }, []);
  const cls = entry.stale
    ? "border-[var(--color-err)] text-[color:var(--color-err)]"
    : "bg-[var(--color-brand)] text-white";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] ${cls}`}
    >
      {entry.stale ? "⚠️ orphaned" : "running"} · {formatElapsed(entry.startedAt, now)}
    </span>
  );
}

export function PipelineRow(props: {
  rec: PipelineRecord;
  running: RunningEntry | null;
  onLogsToggle: () => void;
  logsOpen: boolean;
}): React.JSX.Element {
  const { rec, running, onLogsToggle, logsOpen } = props;
  const utils = trpc.useUtils();
  const [dryRun, setDryRun] = useState(false);
  const [confirmRm, setConfirmRm] = useState(false);
  const runMut = trpc.ragPipelineRun.useMutation({
    onSuccess: () => utils.ragPipelineList.invalidate(),
  });
  const removeMut = trpc.ragPipelineRemove.useMutation({
    onSuccess: () => utils.ragPipelineList.invalidate(),
  });

  return (
    <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]">
      <td className="px-3 py-2 text-[color:var(--color-ok)]">{rec.name}</td>
      <td className="px-3 py-2 text-xs">
        {rec.manifest.spec.sources.map((s) => s.kind).join(", ")}
      </td>
      <td className="px-3 py-2 mono text-xs">{rec.manifest.spec.schedule ?? "—"}</td>
      <td className="px-3 py-2">
        {running ? <RunningBadge entry={running} /> : rec.lastRun ? "ok" : "never run"}
      </td>
      <td className="px-3 py-2 text-right">
        <button
          onClick={() => {
            runMut.mutate({ name: rec.name, dryRun });
          }}
          className="rounded bg-[var(--color-brand)] px-2 py-0.5 text-[10px] text-white"
        >
          Run
        </button>
        <button onClick={onLogsToggle} className="ml-1 rounded border px-2 py-0.5 text-[10px]">
          {logsOpen ? "Hide" : "Logs"}
        </button>
        {confirmRm ? (
          <>
            <button
              onClick={() => {
                setConfirmRm(false);
                removeMut.mutate({ name: rec.name });
              }}
              className="ml-1 rounded bg-[var(--color-err)] px-2 py-0.5 text-[10px] text-white"
            >
              Confirm
            </button>
            <button
              onClick={() => {
                setConfirmRm(false);
              }}
              className="ml-1 rounded border px-2 py-0.5 text-[10px]"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            onClick={() => {
              setConfirmRm(true);
            }}
            className="ml-1 rounded bg-[var(--color-err)] px-2 py-0.5 text-[10px] text-white"
          >
            Remove
          </button>
        )}
      </td>
    </tr>
  );
}

export function DraftPanel({
  selectedNode,
  availableNodes,
}: {
  selectedNode: string;
  availableNodes: string[];
}): React.JSX.Element {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [desc, setDesc] = useState("");
  const [yaml, setYaml] = useState("");
  const [drafting, setDrafting] = useState(false);

  async function onDraft(): Promise<void> {
    setDrafting(true);
    try {
      const res = await utils.ragPipelineDraft.fetch({
        description: desc,
        defaultRagNode: selectedNode,
        availableRagNodes: availableNodes,
      });
      setYaml(res.yaml);
    } finally {
      setDrafting(false);
    }
  }

  if (!open)
    return (
      <button
        onClick={() => {
          setOpen(true);
        }}
        className="rounded border px-2 py-1 text-xs"
      >
        Draft from description…
      </button>
    );
  return (
    <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <textarea
        value={desc}
        onChange={(e) => {
          setDesc(e.target.value);
        }}
        rows={2}
        className="w-full rounded border bg-[var(--color-surface-2)] p-2 text-xs"
        placeholder="e.g. crawl https://example.com"
      />
      <div className="mt-2 flex justify-between">
        <button
          onClick={() => {
            void onDraft();
          }}
          disabled={drafting || !desc.trim()}
          className="rounded bg-[var(--color-brand)] px-3 py-1 text-sm text-white"
        >
          {drafting ? "…" : "Draft"}
        </button>
        <button
          onClick={() => {
            setOpen(false);
          }}
          className="text-xs"
        >
          Close
        </button>
      </div>
      {yaml && (
        <pre className="mt-2 max-h-64 overflow-auto rounded border bg-[var(--color-surface-2)] p-2 text-[10px]">
          {yaml}
        </pre>
      )}
    </div>
  );
}
