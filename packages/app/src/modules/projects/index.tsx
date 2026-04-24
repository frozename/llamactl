import * as React from 'react';
import { useMemo, useState } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { trpc, trpcUIClient } from '@/lib/trpc';
import { Badge, Button, EditorialHero } from '@/ui';
import type { BadgeVariant } from '@/ui';

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

function reasonBadgeVariant(reason: RoutingDecision['reason']): BadgeVariant {
  if (reason === 'matched') return 'ok';
  if (reason === 'fallback-default') return 'default';
  return 'err';
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
      <span className="text-[10px] text-[color:var(--color-text-secondary)]">
        no policy
      </span>
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <Badge key={k} variant="default" title={`${k} → ${v}`}>
          {k} → {v}
        </Badge>
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
    return <span className="text-[10px] text-[color:var(--color-text-secondary)]">…</span>;
  }
  if (q.error || !data?.decision) {
    return (
      <span className="text-[10px] text-[color:var(--color-text-secondary)]">—</span>
    );
  }
  const d = data.decision;
  return (
    <Badge
      variant={reasonBadgeVariant(d.reason)}
      title={`reason: ${d.reason}${d.budget ? ` · budget ${d.budget.usdToday?.toFixed(4) ?? '?'}/${d.budget.limit?.toFixed(2) ?? '?'} USD` : ''}`}
      data-testid={`projects-preview-${project}-${taskKind}`}
    >
      {d.target}
    </Badge>
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
      <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-text-secondary)]">
        Loading decisions…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-text-secondary)]"
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
        <thead className="bg-[var(--color-surface-2)] text-left text-[color:var(--color-text-secondary)]">
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
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-text-secondary)]">
                {formatElapsed(d.ts)}
              </td>
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-text)]">
                {d.taskKind}
              </td>
              <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-text)] break-all">
                {d.target}
              </td>
              <td className="px-2 py-1">
                <Badge variant={reasonBadgeVariant(d.reason)}>{d.reason}</Badge>
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
          <div className="text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
            Project
          </div>
          <div className="mono text-lg text-[color:var(--color-text)]">
            {project.metadata.name}
          </div>
          <div className="mono text-xs text-[color:var(--color-text-secondary)]">
            {project.spec.path}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRemove}
            disabled={removeMut.isPending}
            data-testid={`projects-remove-${project.metadata.name}`}
            style={{
              borderColor: 'var(--color-err)',
              color: 'var(--color-err)',
            }}
          >
            Remove
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            data-testid={`projects-detail-close`}
          >
            Close
          </Button>
        </div>
      </div>

      {taskKinds.length > 0 && (
        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
            Routing policy preview
          </div>
          <div
            className="overflow-hidden rounded-md border border-[var(--color-border)]"
            data-testid="projects-policy-table"
          >
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
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
                    <td className="px-2 py-1 mono text-[color:var(--color-text)]">
                      {k}
                    </td>
                    <td className="px-2 py-1 mono text-[10px] text-[color:var(--color-text-secondary)]">
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
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
          Routing decisions (live)
        </div>
        <RoutingJournalFeed project={project.metadata.name} />
      </div>

      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
          Manifest
        </div>
        <pre
          className="max-h-64 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mono text-[10px] text-[color:var(--color-text)]"
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
      <td className="px-3 py-2 text-[color:var(--color-ok)] break-all">
        <button
          type="button"
          onClick={onOpenDetail}
          data-testid={`projects-open-${project.metadata.name}`}
          className="text-left underline decoration-dotted hover:opacity-90"
        >
          {project.metadata.name}
        </button>
      </td>
      <td className="px-3 py-2 text-[color:var(--color-text-secondary)] mono text-[10px] break-all">
        {project.spec.path}
      </td>
      <td className="px-3 py-2 text-[10px]">
        {hasRag ? (
          <span className="mono text-[color:var(--color-text)]">
            {project.spec.rag!.node}/{project.spec.rag!.collection}
          </span>
        ) : (
          <span className="text-[color:var(--color-text-secondary)]">
            no rag block
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <RoutingHeatmap routing={project.spec.routing} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => indexMut.mutate({ name: project.metadata.name })}
            disabled={indexMut.isPending || !hasRag}
            loading={indexMut.isPending}
            data-testid={`projects-index-${project.metadata.name}`}
            title={hasRag ? 'Apply + run the auto-generated RAG pipeline' : 'No rag block declared; add one in the manifest to enable indexing'}
          >
            {indexMut.isPending ? '…' : 'Index'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onOpenDetail}
            data-testid={`projects-detail-button-${project.metadata.name}`}
          >
            Detail
          </Button>
        </div>
        {indexError && (
          <div className="mt-1 text-[10px] text-[color:var(--color-err)]">
            {indexError}
          </div>
        )}
      </td>
    </tr>
  );
}

interface DetectedRepo {
  path: string;
  name: string;
  mtimeMs: number;
}

/**
 * Quick-pick list of git repos the operator has under their default
 * project roots. Scans ~/DevStorage/repos + ~/repos + ~/Projects
 * (two levels deep) for directories containing `.git/`; click a
 * chip to fill the path field with that repo.
 *
 * Roots are hardcoded — adding an override input is a follow-up
 * (probably surfaces as a Settings entry). Default roots cover the
 * common Mac developer layouts; an empty scan just hides the
 * strip.
 */
function GitRepoSuggestions({ onPick }: { onPick: (r: DetectedRepo) => void }): React.JSX.Element | null {
  const [state, setState] = React.useState<
    | { kind: 'loading' }
    | { kind: 'ready'; repos: DetectedRepo[]; rootsShown: string[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const scan = async (): Promise<void> => {
      const candidateRoots = [
        '~/DevStorage/repos/personal',
        '~/DevStorage/repos/work',
        '~/DevStorage/repos',
        '~/repos',
        '~/Projects',
        '~/projects',
        '~/src',
      ];
      const allRepos: DetectedRepo[] = [];
      const rootsShown: string[] = [];
      for (const root of candidateRoots) {
        try {
          const result = await trpcUIClient.uiScanGitRepos.query({
            root,
            maxDepth: 2,
            limit: 30,
          });
          if (cancelled) return;
          if (result.repos.length > 0) {
            rootsShown.push(result.root);
            allRepos.push(...result.repos);
          }
        } catch (err) {
          // Log + keep scanning — one missing root shouldn't stop the rest.
          if (!cancelled) console.warn('scan failed:', root, err);
        }
      }
      if (cancelled) return;
      // Dedupe by path, keep most-recent mtime.
      const seen = new Map<string, DetectedRepo>();
      for (const r of allRepos) {
        const prior = seen.get(r.path);
        if (!prior || prior.mtimeMs < r.mtimeMs) seen.set(r.path, r);
      }
      const repos = Array.from(seen.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
      setState({ kind: 'ready', repos, rootsShown });
    };
    void scan();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="mb-3 text-[10px] text-[color:var(--color-text-secondary)]">
        Scanning for git repos\u2026
      </div>
    );
  }
  if (state.kind === 'error') {
    return null;
  }
  if (state.repos.length === 0) return null;
  const visible = expanded ? state.repos : state.repos.slice(0, 8);
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-baseline gap-2 text-[10px] uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        <span>Detected git repos</span>
        <span className="opacity-60">({state.repos.length} across {state.rootsShown.length} root{state.rootsShown.length === 1 ? '' : 's'})</span>
      </div>
      <div className="flex flex-wrap gap-1" data-testid="projects-git-suggestions">
        {visible.map((repo) => (
          <Button
            key={repo.path}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onPick(repo)}
            title={repo.path}
          >
            {repo.name}
          </Button>
        ))}
        {!expanded && state.repos.length > visible.length && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(true)}
          >
            +{state.repos.length - visible.length} more
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Single-form create-project flow. Posts a minimal ProjectSchema YAML
 * via `projectApply` — no CLI round-trip. Compact mode renders as a
 * one-line "add another" at the top of the table; default mode
 * renders as a full-width wizard in the empty state.
 */
function CreateProjectForm({ compact }: { compact?: boolean } = {}): React.JSX.Element {
  const utils = trpc.useUtils();
  const nodesQuery = trpc.nodeList.useQuery();
  const apply = trpc.projectApply.useMutation({
    onSuccess: async () => {
      await utils.projectList.invalidate();
      setName('');
      setPath('');
      setStatus({ kind: 'ok', message: 'project created' });
    },
    onError: (err) => setStatus({ kind: 'error', message: err.message }),
  });
  const [name, setName] = React.useState('');
  const [path, setPath] = React.useState('');
  const [purpose, setPurpose] = React.useState('');
  const [ragNode, setRagNode] = React.useState<string>('');
  const [ragCollection, setRagCollection] = React.useState('');
  const [status, setStatus] = React.useState<
    | { kind: 'idle' }
    | { kind: 'ok'; message: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const ragNodes = (nodesQuery.data?.nodes ?? []).filter((n) => n.effectiveKind === 'rag');
  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

  function onSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!canSubmit) return;
    setStatus({ kind: 'idle' });
    const manifest: Record<string, unknown> = {
      apiVersion: 'llamactl/v1',
      kind: 'Project',
      metadata: { name: name.trim() },
      spec: {
        path: path.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(ragNode && ragCollection.trim()
          ? {
              rag: {
                node: ragNode,
                collection: ragCollection.trim(),
              },
            }
          : {}),
      },
    };
    const yaml = stringifyYaml(manifest);
    apply.mutate({ manifestYaml: yaml });
  }

  return (
    <form
      onSubmit={onSubmit}
      data-testid="projects-create-form"
      className={compact ? 'rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3' : ''}
    >
      {!compact && (
        <GitRepoSuggestions
          onPick={(repo) => {
            setPath(repo.path);
            if (!name.trim()) setName(repo.name);
          }}
        />
      )}
      <div className={compact ? 'flex flex-wrap items-end gap-2' : 'grid grid-cols-2 gap-3'}>
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="novaflow"
            data-testid="projects-create-name"
            required
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
          />
        </Field>
        <Field label="Path" required>
          <div className="flex gap-1">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/repos/novaflow"
              data-testid="projects-create-path"
              required
              className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={async () => {
                const picked = await trpcUIClient.uiPickDirectory.mutate({
                  title: 'Pick a project directory',
                  defaultPath: path || undefined,
                });
                if (picked) {
                  setPath(picked);
                  if (!name.trim()) {
                    const basename = picked.split('/').filter(Boolean).pop() ?? '';
                    setName(basename);
                  }
                }
              }}
              data-testid="projects-create-pick-dir"
              title="Pick directory\u2026"
            >
              Browse\u2026
            </Button>
          </div>
        </Field>
        {!compact && (
          <>
            <Field label="Purpose">
              <input
                type="text"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
                placeholder="e.g. at-home diagnostic services platform"
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-text)]"
              />
            </Field>
            <Field label="RAG node (optional)">
              <select
                value={ragNode}
                onChange={(e) => setRagNode(e.target.value)}
                className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-text)]"
              >
                <option value="">— skip RAG binding —</option>
                {ragNodes.map((n) => (
                  <option key={n.name} value={n.name}>{n.name}</option>
                ))}
              </select>
            </Field>
            {ragNode && (
              <Field label="RAG collection">
                <input
                  type="text"
                  value={ragCollection}
                  onChange={(e) => setRagCollection(e.target.value)}
                  placeholder="novaflow_docs"
                  className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
                />
              </Field>
            )}
          </>
        )}
        <div className={compact ? '' : 'col-span-2 flex items-center gap-2 pt-1'}>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit || apply.isPending}
            loading={apply.isPending}
            data-testid="projects-create-submit"
          >
            {apply.isPending ? 'Creating…' : compact ? 'Add' : 'Create project'}
          </Button>
          {status.kind === 'error' && (
            <span className="text-[11px] text-[color:var(--color-err)]">{status.message}</span>
          )}
          {status.kind === 'ok' && (
            <span className="text-[11px] text-[color:var(--color-ok)]">✓ {status.message}</span>
          )}
        </div>
      </div>
    </form>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        {label}
        {required && <span className="ml-0.5 text-[color:var(--color-err)]">*</span>}
      </span>
      {children}
    </label>
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
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        Projects
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-[color:var(--color-text)]">
        Local projects
      </h1>
      <p className="mb-6 text-xs text-[color:var(--color-text-secondary)]">
        Registered project directories with per-task routing policies.
        Register via{' '}
        <span className="mono">llamactl project add &lt;name&gt; --path &lt;abs&gt;</span>;
        indexed docs land in the declared rag collection; routing
        decisions for <span className="mono">project:&lt;name&gt;/&lt;taskKind&gt;</span>{' '}
        chat calls stream into the detail view.
      </p>

      {list.isLoading && (
        <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-text-secondary)]">
          Loading projects…
        </div>
      )}
      {list.error && (
        <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {list.error.message}
        </div>
      )}
      {!list.isLoading && !list.error && sorted.length === 0 && (
        <div data-testid="projects-empty" className="space-y-4">
          <EditorialHero
            title="New project"
            titleAccent="starts here"
            lede="Projects bundle workloads, prompts, and knowledge into one namespace. Start with a blank template — you can attach a data pipeline later."
            actions={
              <Button
                type="button"
                variant="primary"
                size="lg"
                onClick={() => {
                  const el = document.querySelector<HTMLInputElement>(
                    '[data-testid="projects-create-name"]',
                  );
                  el?.focus();
                }}
              >
                Create project
              </Button>
            }
          />
          <CreateProjectForm />
        </div>
      )}
      {sorted.length > 0 && (
        <div className="mb-4">
          <CreateProjectForm compact />
        </div>
      )}
      {sorted.length > 0 && (
        <div
          className="overflow-hidden rounded-md border border-[var(--color-border)]"
          data-testid="projects-table"
        >
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
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
