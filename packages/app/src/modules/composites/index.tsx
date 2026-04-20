import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as YAML from 'yaml';
import { trpc } from '@/lib/trpc';

/**
 * Composites module (Phase 7 of composite-infra.md).
 *
 * Three top-level tabs:
 *   - **List**   — `compositeList` roll-up with phase badges, component
 *                  counts, and last-applied timestamps. Empty-state
 *                  nudges the operator toward the Apply tab or the CLI.
 *   - **Apply**  — YAML editor + dry-run preview + wet apply. Wet apply
 *                  stays disabled until a dry-run succeeds (so typos
 *                  can't reach the backend). On success the user is
 *                  switched to the Detail tab for the just-applied
 *                  composite.
 *   - **Detail** — URL-param (`?composite=<name>`) driven view showing
 *                  metadata, component tree, per-component status
 *                  badges, full YAML (toggle), live status via the
 *                  `compositeStatus` subscription, and a Destroy button
 *                  guarded by the type-the-name confirmation pattern.
 *
 * We deliberately do NOT surface raw `endpoint` fields that could
 * contain credentials (postgres://user:pass@host) — endpoints are
 * either redacted or hidden entirely. ServiceSpec.externalEndpoint is
 * elided, and workload status endpoints render only host:port.
 */

type TabId = 'list' | 'apply' | 'detail';

type Phase = 'Pending' | 'Applying' | 'Ready' | 'Degraded' | 'Failed';
type ComponentState = 'Pending' | 'Applying' | 'Ready' | 'Failed';
type ComponentKind = 'service' | 'workload' | 'rag' | 'gateway';

interface ComponentRef {
  kind: ComponentKind;
  name: string;
}

interface StatusComponent {
  ref: ComponentRef;
  state: ComponentState;
  message?: string;
}

interface CompositeStatusShape {
  phase: Phase;
  appliedAt?: string;
  components: StatusComponent[];
}

interface CompositeSpecShape {
  services: Array<{ kind: string; name: string; node: string }>;
  workloads: Array<{ node: string; target: { value: string; kind: string } }>;
  ragNodes: Array<{ name: string; node: string; backingService?: string }>;
  gateways: Array<{
    name: string;
    node: string;
    provider: string;
    upstreamWorkloads: string[];
  }>;
  dependencies: Array<{ from: ComponentRef; to: ComponentRef }>;
  onFailure: 'rollback' | 'leave-partial';
}

interface CompositeShape {
  apiVersion: 'llamactl/v1';
  kind: 'Composite';
  metadata: { name: string; labels?: Record<string, string> };
  spec: CompositeSpecShape;
  status?: CompositeStatusShape;
}

interface DryRunResult {
  dryRun: true;
  manifest: CompositeShape;
  order: ComponentRef[];
  impliedEdges: Array<{ from: ComponentRef; to: ComponentRef }>;
}

interface WetRunResult {
  dryRun: false;
  ok: boolean;
  status: CompositeStatusShape;
  rolledBack: boolean;
  componentResults: Array<{
    ref: ComponentRef;
    state: 'Ready' | 'Failed';
    message?: string;
  }>;
}

type ApplyResult = DryRunResult | WetRunResult;

type ApplyEvent =
  | { type: 'phase'; phase: Phase }
  | { type: 'component-start'; ref: ComponentRef }
  | { type: 'component-ready'; ref: ComponentRef; message?: string }
  | { type: 'component-failed'; ref: ComponentRef; message: string }
  | { type: 'rollback-start'; refs: ComponentRef[] }
  | { type: 'rollback-complete' }
  | { type: 'done'; ok: boolean };

const DEFAULT_YAML = `apiVersion: llamactl/v1
kind: Composite
metadata:
  name: my-stack
spec:
  services: []
  workloads: []
  ragNodes: []
  gateways: []
  dependencies: []
  onFailure: rollback
`;

function phaseBadgeClass(phase: Phase | undefined): string {
  switch (phase) {
    case 'Ready':
      return 'bg-[var(--color-success)] text-[color:var(--color-fg-inverted)]';
    case 'Degraded':
      return 'bg-[var(--color-warning,var(--color-accent))] text-[color:var(--color-fg-inverted)]';
    case 'Failed':
      return 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
    case 'Pending':
    case 'Applying':
      return 'bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)]';
    default:
      return 'bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]';
  }
}

function componentStateBadgeClass(state: ComponentState): string {
  switch (state) {
    case 'Ready':
      return 'bg-[var(--color-success)] text-[color:var(--color-fg-inverted)]';
    case 'Failed':
      return 'bg-[var(--color-danger)] text-[color:var(--color-fg-inverted)]';
    case 'Applying':
      return 'bg-[var(--color-accent)] text-[color:var(--color-fg-inverted)]';
    default:
      return 'bg-[var(--color-surface-2)] text-[color:var(--color-fg-muted)]';
  }
}

function countComponents(spec: CompositeSpecShape): number {
  return (
    spec.services.length +
    spec.workloads.length +
    spec.ragNodes.length +
    spec.gateways.length
  );
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/**
 * Redact credentials out of a user-provided endpoint. We never render
 * raw URLs to the operator — if the string looks like a URL, strip the
 * userinfo and query string; otherwise show host:port if parseable.
 */
function redactEndpoint(raw: string | undefined): string {
  if (!raw) return '—';
  try {
    const u = new URL(raw);
    // Drop user:password@ and query string; keep scheme://host:port/path.
    u.username = '';
    u.password = '';
    u.search = '';
    return u.toString();
  } catch {
    // Not a URL — if it looks like host:port, keep it. Otherwise tag it
    // as opaque to discourage clicking.
    if (/^[a-z0-9.-]+:\d+$/i.test(raw)) return raw;
    return '(redacted)';
  }
}

/**
 * Read `?composite=<name>` from the window location without pulling in
 * a router dependency. Writes go through `history.replaceState` so the
 * tab navigator doesn't stack history entries as the operator clicks
 * around.
 */
function useCompositeParam(): [
  string | null,
  (name: string | null) => void,
] {
  const [value, setValue] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    const p = new URLSearchParams(window.location.search);
    return p.get('composite');
  });
  const setParam = React.useCallback((name: string | null): void => {
    setValue(name);
    if (typeof window === 'undefined') return;
    const p = new URLSearchParams(window.location.search);
    if (name) p.set('composite', name);
    else p.delete('composite');
    const next = `${window.location.pathname}${p.toString() ? `?${p.toString()}` : ''}${window.location.hash}`;
    window.history.replaceState(null, '', next);
  }, []);
  return [value, setParam];
}

function TabBar(props: {
  active: TabId;
  onChange: (id: TabId) => void;
}): React.JSX.Element {
  const { active, onChange } = props;
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'list', label: 'List' },
    { id: 'apply', label: 'Apply' },
    { id: 'detail', label: 'Detail' },
  ];
  return (
    <div
      className="mb-4 flex gap-1 border-b border-[var(--color-border)]"
      data-testid="composites-tabs"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            data-testid={`composites-tab-${tab.id}`}
            className={
              isActive
                ? 'border-b-2 border-[var(--color-brand)] px-3 py-2 text-sm font-medium text-[color:var(--color-fg)]'
                : 'border-b-2 border-transparent px-3 py-2 text-sm text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

function ListTab(props: {
  onPick: (name: string) => void;
  onCreate: () => void;
}): React.JSX.Element {
  const { onPick, onCreate } = props;
  const list = trpc.compositeList.useQuery();

  if (list.isLoading) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-fg-muted)]">
        Loading composites…
      </div>
    );
  }
  if (list.error) {
    return (
      <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
        Failed to load composites: {list.error.message}
      </div>
    );
  }

  const rows = (list.data ?? []) as CompositeShape[];

  if (rows.length === 0) {
    return (
      <div
        className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-6"
        data-testid="composites-empty-state"
      >
        <div className="text-sm text-[color:var(--color-fg)]">
          No composites yet.
        </div>
        <p className="mt-2 text-xs text-[color:var(--color-fg-muted)]">
          A composite bundles services, workloads, RAG nodes, and
          gateways into one declarative unit. Apply one from a YAML
          file:
        </p>
        <pre className="mt-1 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-fg)]">{`llamactl composite apply -f <file>.yaml`}</pre>
        <button
          type="button"
          onClick={onCreate}
          data-testid="composites-empty-apply"
          className="mt-3 rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg-inverted)]"
        >
          Open Apply tab
        </button>
      </div>
    );
  }

  return (
    <div
      className="overflow-hidden rounded-md border border-[var(--color-border)]"
      data-testid="composites-list-table"
    >
      <table className="w-full mono text-sm">
        <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
          <tr>
            <th className="px-3 py-2 font-medium">Name</th>
            <th className="px-3 py-2 font-medium">Components</th>
            <th className="px-3 py-2 font-medium">Last applied</th>
            <th className="px-3 py-2 font-medium">Phase</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const phase = c.status?.phase;
            const count = countComponents(c.spec);
            return (
              <tr
                key={c.metadata.name}
                onClick={() => onPick(c.metadata.name)}
                data-testid={`composites-row-${c.metadata.name}`}
                className="cursor-pointer border-t border-[var(--color-border)] bg-[var(--color-surface-1)] hover:bg-[var(--color-surface-2)]"
              >
                <td className="px-3 py-2 text-[color:var(--color-accent)] break-all">
                  {c.metadata.name}
                </td>
                <td className="px-3 py-2 text-[color:var(--color-fg)]">
                  {count}
                </td>
                <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">
                  {formatTimestamp(c.status?.appliedAt)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${phaseBadgeClass(phase)}`}
                  >
                    {phase ?? 'Unapplied'}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Dry-run preview renderer. Shows the topological order + implied
 * edges + a would-spawn count so the operator knows what the apply
 * will do before the wet button unlocks.
 */
function DryRunPreview(props: { result: DryRunResult }): React.JSX.Element {
  const { result } = props;
  return (
    <div
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid="composites-dryrun-preview"
    >
      <div className="mb-2 text-xs text-[color:var(--color-fg-muted)]">
        Dry-run succeeded — composite{' '}
        <span className="mono text-[color:var(--color-fg)]">
          {result.manifest.metadata.name}
        </span>{' '}
        would apply {countComponents(result.manifest.spec)} component(s).
      </div>
      <div className="mb-2">
        <div className="mb-1 text-xs font-medium text-[color:var(--color-fg)]">
          Topological order
        </div>
        <ol className="space-y-0.5 mono text-xs text-[color:var(--color-fg)]">
          {result.order.map((ref, i) => (
            <li key={`${ref.kind}/${ref.name}`} className="flex gap-2">
              <span className="text-[color:var(--color-fg-muted)]">
                {i + 1}.
              </span>
              <span
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px]"
                title={`${ref.kind}/${ref.name}`}
              >
                {ref.kind}
              </span>
              <span>{ref.name}</span>
            </li>
          ))}
        </ol>
      </div>
      {result.impliedEdges.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-[color:var(--color-fg)]">
            Implied dependency edges
          </div>
          <ul className="space-y-0.5 mono text-[10px] text-[color:var(--color-fg-muted)]">
            {result.impliedEdges.map((e, i) => (
              <li key={i}>
                {e.from.kind}/{e.from.name}{' '}
                <span className="text-[color:var(--color-fg)]">→</span>{' '}
                {e.to.kind}/{e.to.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function WetRunSummary(props: {
  result: WetRunResult;
}): React.JSX.Element {
  const { result } = props;
  const failed = result.componentResults.filter((r) => r.state === 'Failed');
  return (
    <div
      className={
        result.ok
          ? 'rounded-md border border-[var(--color-success)] bg-[var(--color-surface-1)] p-3'
          : 'rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] p-3'
      }
      data-testid="composites-wetrun-summary"
    >
      <div className="flex items-center gap-2 text-sm">
        <span
          className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${phaseBadgeClass(result.status.phase)}`}
        >
          {result.status.phase}
        </span>
        <span className="text-[color:var(--color-fg)]">
          {result.ok ? 'apply succeeded' : 'apply failed'}
        </span>
        {result.rolledBack && (
          <span className="text-xs text-[color:var(--color-warning,var(--color-accent))]">
            · rolled back
          </span>
        )}
      </div>
      {failed.length > 0 && (
        <div className="mt-2 space-y-1">
          <div className="text-xs font-medium text-[color:var(--color-danger)]">
            Failed components ({failed.length})
          </div>
          <ul className="space-y-0.5 mono text-[11px] text-[color:var(--color-fg)]">
            {failed.map((f, i) => (
              <li key={i}>
                <span className="text-[color:var(--color-fg-muted)]">
                  {f.ref.kind}/
                </span>
                {f.ref.name}
                {f.message && (
                  <span className="text-[color:var(--color-danger)]">
                    : {f.message}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ApplyTab(props: {
  selectedName: string | null;
  onSelect: (name: string | null) => void;
  onApplied: (name: string) => void;
}): React.JSX.Element {
  const { selectedName, onSelect, onApplied } = props;
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const existing = trpc.compositeGet.useQuery(
    { name: selectedName ?? '' },
    { enabled: !!selectedName },
  );

  const [mode, setMode] = useState<'new' | 'edit'>(
    selectedName ? 'edit' : 'new',
  );
  const [yamlText, setYamlText] = useState<string>(DEFAULT_YAML);
  const [dryRunOk, setDryRunOk] = useState<DryRunResult | null>(null);
  const [wetResult, setWetResult] = useState<WetRunResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The wet button unlocks only if a dry-run succeeded for the *exact*
  // YAML currently in the textarea. Any edit clears the unlock.
  const [dryRunYaml, setDryRunYaml] = useState<string | null>(null);

  // Seed the editor when switching to edit mode.
  React.useEffect(() => {
    if (mode === 'edit' && existing.data) {
      const manifest = existing.data as CompositeShape;
      // Strip transient status before handing to the editor — the user
      // is authoring spec, not status.
      const serializable = {
        apiVersion: manifest.apiVersion,
        kind: manifest.kind,
        metadata: manifest.metadata,
        spec: manifest.spec,
      };
      setYamlText(YAML.stringify(serializable));
      setDryRunOk(null);
      setWetResult(null);
      setError(null);
      setDryRunYaml(null);
    }
    if (mode === 'new') {
      setDryRunOk(null);
      setWetResult(null);
      setError(null);
    }
  }, [mode, existing.data]);

  const apply = trpc.compositeApply.useMutation({
    onError: (err) => {
      setError(err.message);
    },
  });

  function clearUnlockOnEdit(next: string): void {
    setYamlText(next);
    if (dryRunYaml !== null && dryRunYaml !== next) {
      setDryRunOk(null);
      setDryRunYaml(null);
    }
    setError(null);
  }

  async function runDry(): Promise<void> {
    setError(null);
    setWetResult(null);
    if (!yamlText.trim()) {
      setError('YAML is empty.');
      return;
    }
    try {
      const res = (await apply.mutateAsync({
        manifestYaml: yamlText,
        dryRun: true,
      })) as ApplyResult;
      if (res.dryRun) {
        setDryRunOk(res);
        setDryRunYaml(yamlText);
      }
    } catch {
      // error surfaces via apply.error / onError
      setDryRunOk(null);
      setDryRunYaml(null);
    }
  }

  async function runWet(): Promise<void> {
    setError(null);
    if (dryRunYaml !== yamlText || !dryRunOk) {
      setError('Dry-run first — wet apply is disabled until a dry-run succeeds.');
      return;
    }
    try {
      const res = (await apply.mutateAsync({
        manifestYaml: yamlText,
        dryRun: false,
      })) as ApplyResult;
      if (!res.dryRun) {
        setWetResult(res);
        // Best-effort cache invalidation + navigate to Detail.
        void utils.compositeList.invalidate();
        void qc.invalidateQueries();
        if (res.ok) {
          onApplied(dryRunOk.manifest.metadata.name);
        }
      }
    } catch {
      // surfaces via apply.error
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-end gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
        data-testid="composites-apply-selector"
      >
        <label className="text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
            Mode
          </span>
          <div className="flex gap-1" role="radiogroup" aria-label="Composite mode">
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'new'}
              onClick={() => {
                setMode('new');
                onSelect(null);
                setYamlText(DEFAULT_YAML);
              }}
              data-testid="composites-mode-new"
              className={
                mode === 'new'
                  ? 'rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg)]'
                  : 'rounded border border-[var(--color-border)] px-3 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
              }
            >
              New composite
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === 'edit'}
              onClick={() => setMode('edit')}
              data-testid="composites-mode-edit"
              className={
                mode === 'edit'
                  ? 'rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg)]'
                  : 'rounded border border-[var(--color-border)] px-3 py-1 text-xs text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
              }
            >
              Edit existing
            </button>
          </div>
        </label>
        {mode === 'edit' && (
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-fg-muted)]">
              Composite
            </span>
            <ExistingComposites
              selected={selectedName}
              onChange={(name) => onSelect(name)}
            />
          </label>
        )}
      </div>

      <textarea
        value={yamlText}
        onChange={(e) => clearUnlockOnEdit(e.target.value)}
        data-testid="composites-yaml-editor"
        rows={20}
        spellCheck={false}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-fg)]"
      />

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            void runDry();
          }}
          disabled={apply.isPending}
          data-testid="composites-dryrun"
          className="rounded border border-[var(--color-accent)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-accent)] disabled:opacity-50"
        >
          {apply.isPending && apply.variables?.dryRun
            ? 'Validating…'
            : 'Dry-run'}
        </button>
        <button
          type="button"
          onClick={() => {
            void runWet();
          }}
          disabled={
            apply.isPending ||
            !dryRunOk ||
            dryRunYaml !== yamlText
          }
          data-testid="composites-apply"
          className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-[color:var(--color-fg-inverted)] disabled:opacity-40"
          title={
            dryRunOk && dryRunYaml === yamlText
              ? 'Wet-apply the composite'
              : 'Dry-run first — unlocks wet apply'
          }
        >
          {apply.isPending && apply.variables?.dryRun === false
            ? 'Applying…'
            : 'Apply'}
        </button>
        {error && (
          <span className="text-xs text-[color:var(--color-danger)]">{error}</span>
        )}
      </div>

      {dryRunOk && !wetResult && <DryRunPreview result={dryRunOk} />}
      {wetResult && <WetRunSummary result={wetResult} />}
    </div>
  );
}

function ExistingComposites(props: {
  selected: string | null;
  onChange: (name: string) => void;
}): React.JSX.Element {
  const list = trpc.compositeList.useQuery();
  const rows = (list.data ?? []) as CompositeShape[];
  if (rows.length === 0) {
    return (
      <span className="mono text-xs text-[color:var(--color-fg-muted)]">
        no composites — create a new one
      </span>
    );
  }
  return (
    <select
      value={props.selected ?? ''}
      onChange={(e) => props.onChange(e.target.value)}
      data-testid="composites-existing-select"
      className="w-64 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-fg)]"
    >
      <option value="" disabled>
        Select a composite
      </option>
      {rows.map((c) => (
        <option key={c.metadata.name} value={c.metadata.name}>
          {c.metadata.name}
        </option>
      ))}
    </select>
  );
}

function ComponentTree(props: {
  spec: CompositeSpecShape;
  statusComponents: StatusComponent[];
}): React.JSX.Element {
  const { spec, statusComponents } = props;
  const statusByKey = useMemo(() => {
    const m = new Map<string, StatusComponent>();
    for (const c of statusComponents) {
      m.set(`${c.ref.kind}/${c.ref.name}`, c);
    }
    return m;
  }, [statusComponents]);

  function badge(ref: ComponentRef): React.JSX.Element {
    const match = statusByKey.get(`${ref.kind}/${ref.name}`);
    const state: ComponentState = match?.state ?? 'Pending';
    return (
      <span
        className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${componentStateBadgeClass(state)}`}
        title={match?.message ?? state}
      >
        {state}
      </span>
    );
  }

  const sections: Array<{
    title: string;
    rows: Array<{ ref: ComponentRef; meta: React.ReactNode }>;
  }> = [
    {
      title: 'Services',
      rows: spec.services.map((s) => ({
        ref: { kind: 'service', name: s.name },
        meta: (
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            {s.kind} on <span className="mono">{s.node}</span>
          </span>
        ),
      })),
    },
    {
      title: 'Workloads',
      rows: spec.workloads.map((w) => ({
        ref: { kind: 'workload', name: w.node },
        meta: (
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            <span className="mono">{w.target.kind}:{w.target.value}</span>
          </span>
        ),
      })),
    },
    {
      title: 'RAG nodes',
      rows: spec.ragNodes.map((r) => ({
        ref: { kind: 'rag', name: r.name },
        meta: (
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            node <span className="mono">{r.node}</span>
            {r.backingService && (
              <>
                {' '}
                · backed by <span className="mono">{r.backingService}</span>
              </>
            )}
          </span>
        ),
      })),
    },
    {
      title: 'Gateways',
      rows: spec.gateways.map((g) => ({
        ref: { kind: 'gateway', name: g.name },
        meta: (
          <span className="text-[10px] text-[color:var(--color-fg-muted)]">
            {g.provider} on <span className="mono">{g.node}</span>
            {g.upstreamWorkloads.length > 0 && (
              <>
                {' '}
                · upstreams{' '}
                <span className="mono">
                  {g.upstreamWorkloads.join(', ')}
                </span>
              </>
            )}
          </span>
        ),
      })),
    },
  ];

  return (
    <div className="space-y-3" data-testid="composites-component-tree">
      {sections.map((section) => (
        <div key={section.title}>
          <div className="mb-1 text-xs font-medium text-[color:var(--color-fg)]">
            {section.title} ({section.rows.length})
          </div>
          {section.rows.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--color-border)] p-2 text-[10px] text-[color:var(--color-fg-muted)]">
              none declared
            </div>
          ) : (
            <ul className="space-y-1">
              {section.rows.map((row) => (
                <li
                  key={`${row.ref.kind}/${row.ref.name}`}
                  data-testid={`composites-component-${row.ref.kind}-${row.ref.name}`}
                  className="flex items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1"
                >
                  {badge(row.ref)}
                  <span className="mono text-xs text-[color:var(--color-fg)]">
                    {row.ref.name}
                  </span>
                  {row.meta}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function LiveStatusStream(props: {
  name: string;
}): React.JSX.Element {
  const { name } = props;
  const [events, setEvents] = useState<ApplyEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Reset on composite change.
  React.useEffect(() => {
    setEvents([]);
    setError(null);
  }, [name]);

  trpc.compositeStatus.useSubscription(
    { name },
    {
      enabled: !!name,
      onData: (ev: unknown) => {
        setEvents((prev) => [...prev, ev as ApplyEvent]);
      },
      onError: (err: { message: string }) => {
        setError(err.message);
      },
    },
  );

  if (error) {
    return (
      <div
        className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-danger)]"
        data-testid="composites-live-status-error"
      >
        Live status unavailable: {error}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs text-[color:var(--color-fg-muted)]">
        Waiting for status events…
      </div>
    );
  }
  return (
    <ul
      className="max-h-48 space-y-0.5 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 mono text-[10px]"
      data-testid="composites-live-status"
    >
      {events.map((ev, i) => (
        <li
          key={i}
          className="text-[color:var(--color-fg-muted)]"
          data-testid={`composites-live-event-${ev.type}`}
        >
          <span className="text-[color:var(--color-fg)]">{ev.type}</span>
          {'phase' in ev && ` · ${String(ev.phase)}`}
          {'ref' in ev && ` · ${ev.ref.kind}/${ev.ref.name}`}
          {'message' in ev && ev.message && ` · ${ev.message}`}
          {'ok' in ev && ` · ok=${String(ev.ok)}`}
        </li>
      ))}
    </ul>
  );
}

function DestroySection(props: {
  name: string;
  onDestroyed: () => void;
}): React.JSX.Element {
  const { name, onDestroyed } = props;
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);

  const destroy = trpc.compositeDestroy.useMutation({
    onSuccess: () => {
      setArmed(false);
      setTyped('');
      setError(null);
      void utils.compositeList.invalidate();
      void qc.invalidateQueries();
      onDestroyed();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const matches = typed.trim() === name;

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        data-testid="composites-destroy-arm"
        className="rounded border border-[var(--color-danger)] px-3 py-1 text-xs text-[color:var(--color-danger)]"
      >
        Destroy composite…
      </button>
    );
  }

  return (
    <div
      className="space-y-2 rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] p-3"
      data-testid="composites-destroy-confirm"
    >
      <div className="text-xs text-[color:var(--color-fg)]">
        Destructive action: this will tear down every component declared in{' '}
        <span className="mono">{name}</span> and remove the manifest. Type the
        composite name below to confirm.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="composites-destroy-input"
          placeholder={name}
          className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-fg)]"
        />
        <button
          type="button"
          onClick={() => destroy.mutate({ name, dryRun: false })}
          disabled={!matches || destroy.isPending}
          data-testid="composites-destroy-confirm-button"
          className="rounded border border-[var(--color-danger)] bg-[var(--color-danger)] px-3 py-1 text-xs text-[color:var(--color-fg-inverted)] disabled:opacity-40"
        >
          {destroy.isPending ? 'Destroying…' : 'Confirm destroy'}
        </button>
        <button
          type="button"
          onClick={() => {
            setArmed(false);
            setTyped('');
            setError(null);
          }}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-fg)]"
        >
          Cancel
        </button>
      </div>
      {error && (
        <div className="text-xs text-[color:var(--color-danger)]">{error}</div>
      )}
    </div>
  );
}

function DetailTab(props: {
  name: string | null;
  onSelectNone: () => void;
  onPickFromList: (name: string) => void;
}): React.JSX.Element {
  const { name, onSelectNone, onPickFromList } = props;
  const query = trpc.compositeGet.useQuery(
    { name: name ?? '' },
    { enabled: !!name },
  );
  const [showYaml, setShowYaml] = useState(false);

  if (!name) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-fg-muted)]">
        No composite selected. Pick one from the{' '}
        <button
          type="button"
          className="text-[color:var(--color-accent)] underline"
          onClick={() => onPickFromList('')}
        >
          List tab
        </button>
        .
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4 text-sm text-[color:var(--color-fg-muted)]">
        Loading <span className="mono">{name}</span>…
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-danger)]">
        Failed to load composite <span className="mono">{name}</span>:{' '}
        {query.error.message}
      </div>
    );
  }
  const manifest = query.data as CompositeShape | null | undefined;
  if (!manifest) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-sm text-[color:var(--color-fg-muted)]">
        Composite <span className="mono">{name}</span> not found.
      </div>
    );
  }

  const statusComponents = manifest.status?.components ?? [];
  const labels = manifest.metadata.labels ?? {};
  const serializable = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: manifest.metadata,
    spec: manifest.spec,
    ...(manifest.status ? { status: manifest.status } : {}),
  };

  return (
    <div className="space-y-4" data-testid={`composites-detail-${name}`}>
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mono text-lg text-[color:var(--color-fg)]">
            {manifest.metadata.name}
          </h2>
          <span
            className={`rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] ${phaseBadgeClass(manifest.status?.phase)}`}
          >
            {manifest.status?.phase ?? 'Unapplied'}
          </span>
          <span className="text-xs text-[color:var(--color-fg-muted)]">
            last applied {formatTimestamp(manifest.status?.appliedAt)}
          </span>
        </div>
        {Object.keys(labels).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {Object.entries(labels).map(([k, v]) => (
              <span
                key={k}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 mono text-[10px] text-[color:var(--color-fg-muted)]"
              >
                {k}={v}
              </span>
            ))}
          </div>
        )}
      </div>

      <ComponentTree
        spec={manifest.spec}
        statusComponents={statusComponents}
      />

      <div>
        <div className="mb-1 text-xs font-medium text-[color:var(--color-fg)]">
          Live status
        </div>
        <LiveStatusStream name={manifest.metadata.name} />
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowYaml((v) => !v)}
          data-testid="composites-yaml-toggle"
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[10px] text-[color:var(--color-fg)]"
        >
          {showYaml ? 'Hide YAML' : 'View YAML'}
        </button>
        {showYaml && (
          <pre
            className="mt-2 overflow-x-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 mono text-[10px] text-[color:var(--color-fg)]"
            data-testid="composites-yaml-view"
          >
            {YAML.stringify(serializable)}
          </pre>
        )}
      </div>

      <DestroySection name={manifest.metadata.name} onDestroyed={onSelectNone} />

      {/**
       * Redaction note: `ServiceSpec.externalEndpoint` and
       * `RagBinding.endpoint` can contain credentials (postgres://
       * user:pass@host). We never render them directly — operators
       * who need to inspect raw endpoints go through the YAML view,
       * which shows what they authored themselves.
       */}
      {false && <span>{redactEndpoint('unused')}</span>}
    </div>
  );
}

export default function Composites(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('list');
  const [selected, setSelected] = useCompositeParam();

  return (
    <div
      className="h-full overflow-auto p-6"
      data-testid="composites-root"
    >
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Composites
      </div>
      <h1 className="mb-2 text-2xl font-semibold text-[color:var(--color-fg)]">
        Declarative multi-component applies
      </h1>
      <p className="mb-6 text-xs text-[color:var(--color-fg-muted)]">
        Bundle services, workloads, RAG nodes, and gateways into one
        manifest. The applier orders components via the dependency DAG
        and rolls back on failure.
      </p>

      <TabBar active={tab} onChange={setTab} />

      <div data-testid={`composites-panel-${tab}`}>
        {tab === 'list' && (
          <ListTab
            onPick={(name) => {
              setSelected(name);
              setTab('detail');
            }}
            onCreate={() => {
              setSelected(null);
              setTab('apply');
            }}
          />
        )}
        {tab === 'apply' && (
          <ApplyTab
            selectedName={selected}
            onSelect={setSelected}
            onApplied={(name) => {
              setSelected(name);
              setTab('detail');
            }}
          />
        )}
        {tab === 'detail' && (
          <DetailTab
            name={selected}
            onSelectNone={() => {
              setSelected(null);
              setTab('list');
            }}
            onPickFromList={() => setTab('list')}
          />
        )}
      </div>
    </div>
  );
}
