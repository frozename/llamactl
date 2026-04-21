import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Pipelines tab — the operator-facing view of the R1/R2 RAG
 * ingestion pipelines. Lists every applied pipeline (filtered to
 * those targeting the selected rag node), surfaces last-run status
 * and schedule, and exposes row actions:
 *
 *   - Run: fires `ragPipelineRun` (--dry-run toggle available).
 *   - Logs: opens a side panel that polls `ragPipelineLogs` every
 *     2s for the last 200 journal entries.
 *   - Remove: calls `ragPipelineRemove` after a confirm dialog.
 *
 * "New pipeline" is a placeholder button in v1 — wiring it to the
 * wizard modal is R3.c. The draft-from-NL hook is exposed as a
 * separate "Draft from description…" button that hits
 * `ragPipelineDraft` and dumps the returned YAML into a preview
 * area the operator can copy + paste into an apply command.
 */

interface PipelineManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    destination: { ragNode: string; collection: string };
    sources: Array<{ kind: string } & Record<string, unknown>>;
    schedule?: string;
    on_duplicate?: 'skip' | 'replace' | 'version';
  };
}

interface PipelineRecord {
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
    };
  };
}

interface PipelineListResponse {
  pipelines: PipelineRecord[];
}

interface LogsResponse {
  path: string;
  entries: Array<Record<string, unknown>>;
}

function formatRelative(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function LastRunBadge(props: { rec: PipelineRecord }): React.JSX.Element {
  const { rec } = props;
  if (!rec.lastRun) {
    return (
      <span
        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-muted)]"
        data-testid="pipelines-lastrun-none"
      >
        never run
      </span>
    );
  }
  const { summary, at } = rec.lastRun;
  const ok = summary.errors === 0;
  const cls = ok
    ? 'bg-[var(--color-success)] text-[color:var(--color-fg-inverted)]'
    : 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
  return (
    <div className="flex items-baseline gap-2" data-testid="pipelines-lastrun">
      <span
        className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${cls}`}
        title={`${summary.total_docs} docs · ${summary.total_chunks} chunks · ${summary.errors} errors`}
      >
        {ok ? 'ok' : `${summary.errors} err`}
      </span>
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">
        {summary.total_docs}/{summary.total_chunks} · {formatRelative(at)}
      </span>
    </div>
  );
}

function LogsPanel(props: {
  name: string;
  onClose: () => void;
}): React.JSX.Element {
  const { name, onClose } = props;
  const logs = trpc.ragPipelineLogs.useQuery(
    { name, tail: 200 },
    { refetchInterval: 2000, retry: false },
  );
  const data = logs.data as LogsResponse | undefined;
  const entries = data?.entries ?? [];

  return (
    <div
      className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]"
      data-testid={`pipelines-logs-panel-${name}`}
    >
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
        <div className="text-xs text-[color:var(--color-fg-muted)]">
          Logs for <span className="mono text-[color:var(--color-fg)]">{name}</span>
          {data?.path && <span className="ml-2 mono">{data.path}</span>}
        </div>
        <button
          type="button"
          onClick={onClose}
          data-testid={`pipelines-logs-close-${name}`}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          Close
        </button>
      </div>
      {logs.isLoading && (
        <div className="p-3 text-sm text-[color:var(--color-fg-muted)]">Loading…</div>
      )}
      {logs.error && (
        <div className="p-3 text-sm text-[color:var(--color-danger)]">
          {logs.error.message}
        </div>
      )}
      {!logs.isLoading && !logs.error && entries.length === 0 && (
        <div className="p-3 text-sm text-[color:var(--color-fg-muted)]">
          Journal empty — the pipeline hasn't run yet.
        </div>
      )}
      {entries.length > 0 && (
        <pre className="max-h-96 overflow-auto p-3 mono text-[10px] text-[color:var(--color-fg)]">
          {entries.map((e) => `${JSON.stringify(e)}\n`).join('')}
        </pre>
      )}
    </div>
  );
}

function PipelineRow(props: {
  rec: PipelineRecord;
  onLogsToggle: () => void;
  logsOpen: boolean;
}): React.JSX.Element {
  const { rec, onLogsToggle, logsOpen } = props;
  const utils = trpc.useUtils();
  const [dryRun, setDryRun] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const runMut = trpc.ragPipelineRun.useMutation({
    onSuccess: async () => {
      setActionError(null);
      // Refresh list so last-run column flips.
      await utils.ragPipelineList.invalidate();
    },
    onError: (err) => setActionError(err.message),
  });
  const removeMut = trpc.ragPipelineRemove.useMutation({
    onSuccess: async () => {
      setActionError(null);
      await utils.ragPipelineList.invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  const onRun = (): void => {
    setActionError(null);
    runMut.mutate({ name: rec.name, dryRun });
  };
  const onRemove = (): void => {
    // eslint-disable-next-line no-alert
    if (!confirm(`Remove pipeline '${rec.name}'? Applied documents stay in the rag node.`)) {
      return;
    }
    setActionError(null);
    removeMut.mutate({ name: rec.name });
  };

  const schedule = rec.manifest.spec.schedule ?? '—';
  const sources = rec.manifest.spec.sources
    .map((s) => s.kind)
    .join(', ');

  return (
    <>
      <tr
        className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
        data-testid={`pipelines-row-${rec.name}`}
      >
        <td className="px-3 py-2 text-[color:var(--color-accent)] break-all">
          {rec.name}
        </td>
        <td className="px-3 py-2 text-[color:var(--color-fg)] text-xs">
          {sources}
        </td>
        <td className="px-3 py-2 mono text-xs text-[color:var(--color-fg-muted)]">
          {schedule}
        </td>
        <td className="px-3 py-2">
          <LastRunBadge rec={rec} />
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <label className="flex items-center gap-1 text-[10px] text-[color:var(--color-fg-muted)]">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                data-testid={`pipelines-dryrun-${rec.name}`}
              />
              dry
            </label>
            <button
              type="button"
              onClick={onRun}
              disabled={runMut.isPending}
              data-testid={`pipelines-run-${rec.name}`}
              className="rounded bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {runMut.isPending ? '…' : 'Run'}
            </button>
            <button
              type="button"
              onClick={onLogsToggle}
              data-testid={`pipelines-logs-toggle-${rec.name}`}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
            >
              {logsOpen ? 'Hide logs' : 'Logs'}
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={removeMut.isPending}
              data-testid={`pipelines-remove-${rec.name}`}
              className="rounded border border-[var(--color-danger)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-danger)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Remove
            </button>
          </div>
        </td>
      </tr>
      {actionError && (
        <tr className="bg-[var(--color-surface-1)]">
          <td colSpan={5} className="px-3 py-2 text-xs text-[color:var(--color-danger)]">
            {actionError}
          </td>
        </tr>
      )}
      {logsOpen && (
        <tr className="bg-[var(--color-surface-1)]">
          <td colSpan={5} className="px-3 py-2">
            <LogsPanel name={rec.name} onClose={onLogsToggle} />
          </td>
        </tr>
      )}
    </>
  );
}

function DraftPanel(props: {
  selectedNode: string;
  availableNodes: string[];
}): React.JSX.Element {
  const { selectedNode, availableNodes } = props;
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const [yaml, setYaml] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  async function onDraft(): Promise<void> {
    setError(null);
    setDrafting(true);
    try {
      const input: {
        description: string;
        availableRagNodes?: string[];
        defaultRagNode?: string;
        nameOverride?: string;
      } = { description, defaultRagNode: selectedNode };
      if (availableNodes.length > 0) input.availableRagNodes = availableNodes;
      if (nameOverride.trim()) input.nameOverride = nameOverride.trim();
      const res = await utils.ragPipelineDraft.fetch(input);
      setYaml(res.yaml);
      setWarnings(res.warnings);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  if (!open) {
    return (
      <div className="mb-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="pipelines-draft-open"
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          Draft from description…
        </button>
      </div>
    );
  }

  return (
    <div
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid="pipelines-draft-panel"
    >
      <div className="mb-2 flex items-baseline justify-between">
        <div className="text-xs text-[color:var(--color-fg-muted)]">
          Draft a pipeline manifest from a description. The drafter is
          deterministic — extracts URLs, paths, schedule aliases, and
          rag node hints. Review the YAML, then apply via CLI or the
          tRPC procedure.
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-12 gap-2">
        <label className="col-span-8 text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            data-testid="pipelines-draft-description"
            placeholder="e.g. crawl https://docs.example.com into kb-pg daily"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-fg)]"
          />
        </label>
        <label className="col-span-2 text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
            Name (optional)
          </span>
          <input
            type="text"
            value={nameOverride}
            onChange={(e) => setNameOverride(e.target.value)}
            data-testid="pipelines-draft-name"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-fg)]"
          />
        </label>
        <div className="col-span-2 flex items-end">
          <button
            type="button"
            onClick={() => void onDraft()}
            disabled={drafting || !description.trim()}
            data-testid="pipelines-draft-submit"
            className="w-full rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {drafting ? '…' : 'Draft'}
          </button>
        </div>
      </div>
      {error && (
        <div className="mt-2 text-xs text-[color:var(--color-danger)]">{error}</div>
      )}
      {warnings.length > 0 && (
        <ul
          className="mt-2 space-y-1 text-xs text-[color:var(--color-fg-muted)]"
          data-testid="pipelines-draft-warnings"
        >
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
      {yaml && (
        <pre
          className="mt-2 max-h-64 overflow-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-fg)]"
          data-testid="pipelines-draft-yaml"
        >
          {yaml}
        </pre>
      )}
    </div>
  );
}

export function PipelinesTab(props: {
  nodeName: string;
  availableNodes: string[];
}): React.JSX.Element {
  const { nodeName, availableNodes } = props;
  const list = trpc.ragPipelineList.useQuery(undefined, { retry: false });
  const data = list.data as PipelineListResponse | undefined;
  const rows = data?.pipelines ?? [];
  const [logsOpen, setLogsOpen] = useState<string | null>(null);

  // Show every pipeline; filter note if it targets a different node.
  // Operators often have a single rag node, but filtering would hide
  // misconfigured pipelines — we surface them instead.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  );

  return (
    <div className="space-y-4" data-testid="pipelines-root">
      <DraftPanel selectedNode={nodeName} availableNodes={availableNodes} />

      {list.isLoading && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-fg-muted)]">
          Loading pipelines…
        </div>
      )}
      {list.error && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
          {list.error.message}
        </div>
      )}
      {!list.isLoading && !list.error && sorted.length === 0 && (
        <div
          className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-6 text-sm text-[color:var(--color-fg-muted)]"
          data-testid="pipelines-empty"
        >
          <div className="text-[color:var(--color-fg)]">
            No pipelines applied yet.
          </div>
          <p className="mt-2 text-xs">
            Apply one from the CLI:
          </p>
          <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-fg)]">{`llamactl rag pipeline apply -f templates/rag-pipelines/llamactl-docs.yaml`}</pre>
          <p className="mt-2 text-xs">
            Or use the Draft button above to scaffold a new manifest from a
            description.
          </p>
        </div>
      )}
      {sorted.length > 0 && (
        <div
          className="overflow-hidden rounded-md border border-[var(--color-border)]"
          data-testid="pipelines-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
              <tr>
                <th className="px-3 py-2 font-medium mono">Name</th>
                <th className="px-3 py-2 font-medium">Sources</th>
                <th className="px-3 py-2 font-medium">Schedule</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="w-64 px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((rec) => (
                <PipelineRow
                  key={rec.name}
                  rec={rec}
                  onLogsToggle={() =>
                    setLogsOpen((cur) => (cur === rec.name ? null : rec.name))
                  }
                  logsOpen={logsOpen === rec.name}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
