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
      <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
        no policy
      </span>
    );
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
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
    return <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>…</span>;
  }
  if (q.error || !data?.decision) {
    return (
      <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>—</span>
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
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Loading decisions…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}
        data-testid="projects-journal-empty"
      >
        No routing decisions journaled yet — trigger a chat against{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>project:{project}/&lt;taskKind&gt;</span> to
        populate this feed.
      </div>
    );
  }
  // Newest last — reverse for display.
  const reversed = [...entries].reverse();
  return (
    <div
      style={{ overflow: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}
      data-testid="projects-journal"
    >
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead style={{ background: 'var(--color-surface-2)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
          <tr>
            <th style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Elapsed</th>
            <th style={{ width: 128, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Task kind</th>
            <th style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Target</th>
            <th style={{ width: 128, paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {reversed.map((d, i) => (
            <tr
              key={`${d.ts}-${i}`}
              style={{ borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
            >
              <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {formatElapsed(d.ts)}
              </td>
              <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}>
                {d.taskKind}
              </td>
              <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)', wordBreak: 'break-all' }}>
                {d.target}
              </td>
              <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
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
      style={{ marginTop: 16, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-0)', padding: 16 }}
      data-testid={`projects-detail-${project.metadata.name}`}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
            Project
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--color-text)' }}>
            {project.metadata.name}
          </div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            {project.spec.path}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onRemove}
            disabled={removeMut.isPending}
            data-testid={`projects-remove-${project.metadata.name}`}
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
          <div style={{ marginBottom: 8, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
            Routing policy preview
          </div>
          <div
            style={{ overflow: 'hidden', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
            data-testid="projects-policy-table"
          >
            <table style={{ width: '100%', fontSize: 12 }}>
              <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                <tr>
                  <th style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Task kind</th>
                  <th style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Declared target</th>
                  <th style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontWeight: 500 }}>Resolved (live)</th>
                </tr>
              </thead>
              <tbody>
                {taskKinds.map((k) => (
                  <tr
                    key={k}
                    style={{ borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}
                  >
                    <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}>
                      {k}
                    </td>
                    <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                      {project.spec.routing?.[k]}
                    </td>
                    <td style={{ paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}>
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
        <div style={{ marginBottom: 8, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Routing decisions (live)
        </div>
        <RoutingJournalFeed project={project.metadata.name} />
      </div>

      <div>
        <div style={{ marginBottom: 8, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Manifest
        </div>
        <pre
          style={{ overflow: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 12, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}
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
      style={{ borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}
      data-testid={`projects-row-${project.metadata.name}`}
    >
      <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-ok)', wordBreak: 'break-all' }}>
        <button
          type="button"
          onClick={onOpenDetail}
          data-testid={`projects-open-${project.metadata.name}`}
          style={{ textAlign: 'left' }}
        >
          {project.metadata.name}
        </button>
      </td>
      <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 10, wordBreak: 'break-all' }}>
        {project.spec.path}
      </td>
      <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 10 }}>
        {hasRag ? (
          <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}>
            {project.spec.rag!.node}/{project.spec.rag!.collection}
          </span>
        ) : (
          <span style={{ color: 'var(--color-text-secondary)' }}>
            no rag block
          </span>
        )}
      </td>
      <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}>
        <RoutingHeatmap routing={project.spec.routing} />
      </td>
      <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, textAlign: 'right' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
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
          <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-err)' }}>
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
      <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
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
    <div >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        <span>Detected git repos</span>
        <span style={{ opacity: 0.6 }}>({state.repos.length} across {state.rootsShown.length} root{state.rootsShown.length === 1 ? '' : 's'})</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} data-testid="projects-git-suggestions">
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
      style={{ ...( compact ? { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 } : {  } ) }}
    >
      {!compact && (
        <GitRepoSuggestions
          onPick={(repo) => {
            setPath(repo.path);
            if (!name.trim()) setName(repo.name);
          }}
        />
      )}
      <div style={{ ...( compact ? { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8 } : { display: 'grid', gap: 12 } ) }}>
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="novaflow"
            data-testid="projects-create-name"
            required
            style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}
          />
        </Field>
        <Field label="Path" required>
          <div style={{ display: 'flex', gap: 4 }}>
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/repos/novaflow"
              data-testid="projects-create-path"
              required
              style={{ flex: 1, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}
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
                style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontSize: 12, color: 'var(--color-text)' }}
              />
            </Field>
            <Field label="RAG node (optional)">
              <select
                value={ragNode}
                onChange={(e) => setRagNode(e.target.value)}
                style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontSize: 12, color: 'var(--color-text)' }}
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
                  style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}
                />
              </Field>
            )}
          </>
        )}
        <div style={{ ...( compact ? {  } : { gridColumn: 'span 2 / span 2', display: 'flex', alignItems: 'center', gap: 8 } ) }}>
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
            <span style={{ fontSize: 11, color: 'var(--color-err)' }}>{status.message}</span>
          )}
          {status.kind === 'ok' && (
            <span style={{ fontSize: 11, color: 'var(--color-ok)' }}>✓ {status.message}</span>
          )}
        </div>
      </div>
    </form>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        {label}
        {required && <span style={{ color: 'var(--color-err)' }}>*</span>}
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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="projects-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        Projects
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Local projects
      </h1>
      <p style={{ marginBottom: 24, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        Registered project directories with per-task routing policies.
        Register via{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>llamactl project add &lt;name&gt; --path &lt;abs&gt;</span>;
        indexed docs land in the declared rag collection; routing
        decisions for <span style={{ fontFamily: 'var(--font-mono)' }}>project:&lt;name&gt;/&lt;taskKind&gt;</span>{' '}
        chat calls stream into the detail view.
      </p>

      {list.isLoading && (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, fontSize: 14, color: 'var(--color-text-secondary)' }}>
          Loading projects…
        </div>
      )}
      {list.error && (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 14, color: 'var(--color-err)' }}>
          {list.error.message}
        </div>
      )}
      {!list.isLoading && !list.error && sorted.length === 0 && (
        <div data-testid="projects-empty" style={{ marginTop: 16 }}>
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
        <div style={{ marginBottom: 16 }}>
          <CreateProjectForm compact />
        </div>
      )}
      {sorted.length > 0 && (
        <div
          style={{ overflow: 'hidden', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
          data-testid="projects-table"
        >
          <table style={{ width: '100%', fontSize: 14 }}>
            <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
              <tr>
                <th style={{ width: 192, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Name</th>
                <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Path</th>
                <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>RAG</th>
                <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Routing policy</th>
                <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500, textAlign: 'right' }}>Actions</th>
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
        <div >
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
