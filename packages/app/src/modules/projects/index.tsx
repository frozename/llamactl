import * as React from 'react';
import { useMemo, useState } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { trpc } from '@/lib/trpc';

/**
 * Projects module — the Electron surface for the trifold-
 * orchestrating-engelbart plan. Two views:
 *
 *   - List: one row per registered project with last-index status
 *     + routing-policy heatmap + row actions (Index, Open Chat,
 *     Remove).
 *   - Detail: manifest YAML (read-only), per-task-kind routing
 *     preview, recent routing-decision feed polled from the
 *     journal every 2s.
 *
 * No write path for the project manifest itself in v1 — registering
 * + editing still happen via \`llamactl project {add, rm}\`. The UI
 * is read + action (Index/Remove/Open-Chat) oriented; full editor
 * lands in a follow-up if operators ask for it.
 */

interface ProjectManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    path: string;
    purpose?: string;
    stack?: string[];
    rag?: {
      node: string;
      collection: string;
      docsGlob?: string;
      schedule?: string;
    };
    routing?: Record<string, string>;
    budget?: {
      usd_per_day?: number;
      cli_calls_per_day?: Record<string, number>;
    };
  };
}

interface ProjectListResponse {
  ok: true;
  projects: ProjectManifest[];
}

interface RoutingDecision {
  ts: string;
  project: string;
  taskKind: string;
  target: string;
  matched: boolean;
  reason: 'matched' | 'fallback-default' | 'project-not-found' | 'over-budget';
  budget?: { usdToday?: number; limit?: number };
}

interface JournalResponse {
  ok: true;
  path: string;
  entries: RoutingDecision[];
}

interface RoutePreviewResponse {
  ok: true;
  node: string;
  decision: RoutingDecision | null;
}

function reasonClass(reason: RoutingDecision['reason']): string {
  if (reason === 'matched') {
    return 'bg-[var(--color-success)] text-[color:var(--color-fg-inverted)]';
  }
  if (reason === 'fallback-default') {
    return 'bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]';
  }
  return 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
}

function formatElapsed(iso: string, now: number = Date.now()): string {
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

function RoutingHeatmap(props: { routing: Record<string, string> | undefined }): React.JSX.Element {
  const entries = Object.entries(props.routing ?? {});
  if (entries.length === 0) {
    return (
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">
        no policy
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 mono text-[10px] text-[color:var(--color-fg-muted)]"
          title={`${k} → ${v}`}
        >
          {k} → {v}
        </span>
      ))}
    </div>
  );
}

function RoutingPreviewCard(props: {
  project: string;
  taskKind: string;
}): React.JSX.Element {
  const { project, taskKind } = props;
  const q = trpc.projectRoutePreview.useQuery(
    { node: `project:${project}/${taskKind}` },
    { retry: false },
  );
  const data = q.data as RoutePreviewResponse | undefined;
  if (q.isLoading) {
    return <span className="text-[10px] text-[color:var(--color-fg-muted)]">…</span>;
  }
  if (q.error || !data?.decision) {
    return (
      <span className="text-[10px] text-[color:var(--color-fg-muted)]">—</span>
    );
  }
  const d = data.decision;
  return (
    <span
      className={`inline-flex rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${reasonClass(d.reason)}`}
      title={`reason: ${d.reason}${d.budget ? ` · budget ${d.budget.usdToday?.toFixed(4) ?? '?'}/${d.budget.limit?.toFixed(2) ?? '?'} USD` : ''}`}
      data-testid={`projects-preview-${project}-${taskKind}`}
    >
      {d.target}
    </span>
  );
}

function RoutingJournalFeed(props: { project: string }): React.JSX.Element {
  const { project } = props;
  const q = trpc.projectRoutingJournal.useQuery(
    { tail: 50, project },
    { refetchInterval: 2000, retry: false },
  );
  const data = q.data as JournalResponse | undefined;
  const entries = data?.entries ?? [];
  if (q.isLoading) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
        Loading decisions…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-fg-muted)]"
        data-testid="projects-journal-empty"
      >
        No routing decisions journaled yet — trigger a chat against{' '}
        <span className="mono">project:{project}/&lt;taskKind&gt;</span> to
        populate this feed.
      </div>
    );
  }
  // Newest last — reverse for display.
  const reversed = [...entries].reverse();
  return (
    <div
      className="max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)]"
      data-testid="projects-journal"
    >
      <table className="w-full text-xs">
        <thead className="bg-[var(--color-surface-2)] text-left text-[color:var(--color-fg-muted)]">
          <tr>
            <th className="w-24 px-2 py-1 font-medium">Elapsed</th>
            <th className="w-32 px-2 py-1 font-medium">Task kind</th>
            <th className="px-2 py-1 font-medium">Target</th>
            <th className="w-32 px-2 py-1 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {reversed.map((d, i) => (
            <tr
              key={`${d.ts}-${i}`}
              className="border-t border-[var(--color-border)]"
            >
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-fg-muted)]">
                {formatElapsed(d.ts)}
              </td>
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-fg)]">
                {d.taskKind}
              </td>
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-fg)] break-all">
                {d.target}
              </td>
              <td className="px-2 py-1">
                <span
                  className={`inline-flex rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${reasonClass(d.reason)}`}
                >
                  {d.reason}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProjectDetail(props: {
  project: ProjectManifest;
  onClose: () => void;
  onRemoved: () => void;
}): React.JSX.Element {
  const { project, onClose, onRemoved } = props;
  const utils = trpc.useUtils();
  const taskKinds = Object.keys(project.spec.routing ?? {});
  const removeMut = trpc.projectRemove.useMutation({
    onSuccess: async () => {
      await utils.projectList.invalidate();
      onRemoved();
    },
  });
  const onRemove = (): void => {
    // eslint-disable-next-line no-alert
    if (!confirm(`Remove project '${project.metadata.name}'? Indexed data stays in the rag node.`)) {
      return;
    }
    removeMut.mutate({ name: project.metadata.name });
  };
  return (
    <div
      className="space-y-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] p-4"
      data-testid={`projects-detail-${project.metadata.name}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div>
          <div className="text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
            Project
          </div>
          <div className="mono text-lg text-[color:var(--color-fg)]">
            {project.metadata.name}
          </div>
          <div className="mono text-xs text-[color:var(--color-fg-muted)]">
            {project.spec.path}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onRemove}
            disabled={removeMut.isPending}
            data-testid={`projects-remove-${project.metadata.name}`}
            className="rounded border border-[var(--color-danger)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-danger)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Remove
          </button>
          <button
            type="button"
            onClick={onClose}
            data-testid={`projects-detail-close`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
          >
            Close
          </button>
        </div>
      </div>

      {taskKinds.length > 0 && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-fg-muted)]">
            Routing policy preview
          </div>
          <div
            className="overflow-hidden rounded-md border border-[var(--color-border)]"
            data-testid="projects-policy-table"
          >
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
                <tr>
                  <th className="w-40 px-2 py-1 font-medium">Task kind</th>
                  <th className="px-2 py-1 font-medium">Declared target</th>
                  <th className="px-2 py-1 font-medium">Resolved (live)</th>
                </tr>
              </thead>
              <tbody>
                {taskKinds.map((k) => (
                  <tr
                    key={k}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-2 py-1 mono text-[color:var(--color-fg)]">
                      {k}
                    </td>
                    <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-fg-muted)]">
                      {project.spec.routing?.[k]}
                    </td>
                    <td className="px-2 py-1">
                      <RoutingPreviewCard
                        project={project.metadata.name}
                        taskKind={k}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-fg-muted)]">
          Routing decisions (live)
        </div>
        <RoutingJournalFeed project={project.metadata.name} />
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-fg-muted)]">
          Manifest
        </div>
        <pre
          className="max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mono text-[10px] text-[color:var(--color-fg)]"
          data-testid={`projects-manifest-${project.metadata.name}`}
        >
          {stringifyYaml(project)}
        </pre>
      </div>
    </div>
  );
}

function ProjectRow(props: {
  project: ProjectManifest;
  onOpenDetail: () => void;
}): React.JSX.Element {
  const { project, onOpenDetail } = props;
  const utils = trpc.useUtils();
  const [indexError, setIndexError] = useState<string | null>(null);
  const indexMut = trpc.projectIndex.useMutation({
    onSuccess: async () => {
      setIndexError(null);
      await utils.projectList.invalidate();
    },
    onError: (err) => setIndexError(err.message),
  });
  const hasRag = !!project.spec.rag;
  return (
    <tr
      className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
      data-testid={`projects-row-${project.metadata.name}`}
    >
      <td className="px-3 py-2 text-[color:var(--color-accent)] break-all">
        <button
          type="button"
          onClick={onOpenDetail}
          data-testid={`projects-open-${project.metadata.name}`}
          className="text-left underline decoration-dotted hover:opacity-90"
        >
          {project.metadata.name}
        </button>
      </td>
      <td className="px-3 py-2 text-[color:var(--color-fg-muted)] mono text-[10px] break-all">
        {project.spec.path}
      </td>
      <td className="px-3 py-2 text-[10px]">
        {hasRag ? (
          <span className="mono text-[color:var(--color-fg)]">
            {project.spec.rag!.node}/{project.spec.rag!.collection}
          </span>
        ) : (
          <span className="text-[color:var(--color-fg-muted)]">
            no rag block
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <RoutingHeatmap routing={project.spec.routing} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => indexMut.mutate({ name: project.metadata.name })}
            disabled={indexMut.isPending || !hasRag}
            data-testid={`projects-index-${project.metadata.name}`}
            title={hasRag ? 'Apply + run the auto-generated RAG pipeline' : 'No rag block declared; add one in the manifest to enable indexing'}
            className="rounded bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {indexMut.isPending ? '…' : 'Index'}
          </button>
          <button
            type="button"
            onClick={onOpenDetail}
            data-testid={`projects-detail-button-${project.metadata.name}`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]"
          >
            Detail
          </button>
        </div>
        {indexError && (
          <div className="mt-1 text-[10px] text-[color:var(--color-danger)]">
            {indexError}
          </div>
        )}
      </td>
    </tr>
  );
}

export default function Projects(): React.JSX.Element {
  const list = trpc.projectList.useQuery(undefined, { retry: false });
  const data = list.data as ProjectListResponse | undefined;
  const rows = data?.projects ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
    [rows],
  );
  const selectedProject =
    selected !== null ? sorted.find((p) => p.metadata.name === selected) ?? null : null;

  return (
    <div className="h-full overflow-auto p-6" data-testid="projects-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Projects
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-[color:var(--color-fg)]">
        Local projects
      </h1>
      <p className="mb-6 text-xs text-[color:var(--color-fg-muted)]">
        Registered project directories with per-task routing policies.
        Register via{' '}
        <span className="mono">llamactl project add &lt;name&gt; --path &lt;abs&gt;</span>;
        indexed docs land in the declared rag collection; routing
        decisions for <span className="mono">project:&lt;name&gt;/&lt;taskKind&gt;</span>{' '}
        chat calls stream into the detail view.
      </p>

      {list.isLoading && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-fg-muted)]">
          Loading projects…
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
          data-testid="projects-empty"
        >
          <div className="text-[color:var(--color-fg)]">
            No projects registered yet.
          </div>
          <pre className="mt-3 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-fg)]">{`llamactl project add novaflow \\
  --path ~/DevStorage/repos/work/novaflow \\
  --rag-node kb-chroma \\
  --rag-collection novaflow_docs`}</pre>
        </div>
      )}
      {sorted.length > 0 && (
        <div
          className="overflow-hidden rounded-md border border-[var(--color-border)]"
          data-testid="projects-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
              <tr>
                <th className="w-48 px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Path</th>
                <th className="w-56 px-3 py-2 font-medium">RAG</th>
                <th className="px-3 py-2 font-medium">Routing policy</th>
                <th className="w-40 px-3 py-2 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <ProjectRow
                  key={p.metadata.name}
                  project={p}
                  onOpenDetail={() => setSelected(p.metadata.name)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedProject && (
        <div className="mt-6">
          <ProjectDetail
            project={selectedProject}
            onClose={() => setSelected(null)}
            onRemoved={() => setSelected(null)}
          />
        </div>
      )}
    </div>
  );
}
