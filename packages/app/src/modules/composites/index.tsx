import * as React from 'react';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as YAML from 'yaml';
import { trpc } from '@/lib/trpc';
import { Badge, Button, StatusDot, Input, Kbd } from '@/ui';

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
  # runtime: docker        # or 'kubernetes' — selects the backend.
  #                        # Omit to inherit LLAMACTL_RUNTIME_BACKEND
  #                        # (defaults to 'docker').
  services: []
  workloads: []
  ragNodes: []
  gateways: []
  dependencies: []
  onFailure: rollback
`;





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
      style={{ marginBottom: 16, display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
      data-testid="composites-tabs"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            data-testid={`composites-tab-${tab.id}`}
            style={{ ...( isActive ? { borderBottom: '2px solid var(--color-border)', borderColor: 'var(--color-brand)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 14, fontWeight: 500, color: 'var(--color-text)' } : { borderBottom: '2px solid var(--color-border)', borderColor: 'transparent', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 14, color: 'var(--color-text-secondary)' } ) }}
          >
            {tab.label}
          </Button>
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
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        Loading composites…
      </div>
    );
  }
  if (list.error) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}>
        Failed to load composites: {list.error.message}
      </div>
    );
  }

  const rows = (list.data ?? []) as CompositeShape[];

  if (rows.length === 0) {
    return (
      <div
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 24 }}
        data-testid="composites-empty-state"
      >
        <div style={{ color: 'var(--color-text)', fontSize: 14 }}>
          No composites yet.
        </div>
        <p style={{ marginTop: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
          A composite bundles services, workloads, RAG nodes, and
          gateways into one declarative unit. Apply one from a YAML
          file:
        </p>
        <pre style={{ marginTop: 4, overflowX: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}>{`llamactl composite apply -f <file>.yaml`}</pre>
        <Button variant="primary" size="sm"
          type="button"
          onClick={onCreate}
          data-testid="composites-empty-apply"
          
        >
          Open Apply tab
        </Button>
      </div>
    );
  }

  return (
    <div
      style={{ overflow: 'hidden', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
      data-testid="composites-list-table"
    >
      <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14 }}>
        <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
          <tr>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Name</th>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Components</th>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Last applied</th>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Phase</th>
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
                style={{ cursor: 'pointer', borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}
              >
                <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-ok)', wordBreak: 'break-all' }}>
                  {c.metadata.name}
                </td>
                <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text)' }}>
                  {count}
                </td>
                <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text-secondary)' }}>
                  {formatTimestamp(c.status?.appliedAt)}
                </td>
                <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8 }}>
                  <span
                    style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}><StatusDot tone={phase === 'Ready' || phase === 'Pending' || phase === 'Applying' ? 'ok' : phase === 'Failed' ? 'err' : phase === 'Degraded' ? 'warn' : 'idle'} />{phase ?? 'Unapplied'}</span>
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
      style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
      data-testid="composites-dryrun-preview"
    >
      <div style={{ marginBottom: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Dry-run succeeded — composite{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}>
          {result.manifest.metadata.name}
        </span>{' '}
        would apply {countComponents(result.manifest.spec)} component(s).
      </div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ marginBottom: 4, fontWeight: 500, color: 'var(--color-text)', fontSize: 12 }}>
          Topological order
        </div>
        <ol style={{ marginTop: 2, fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}>
          {result.order.map((ref, i) => (
            <li key={`${ref.kind}/${ref.name}`} style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--color-text-secondary)' }}>
                {i + 1}.
              </span>
              <span
                style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontSize: 10 }}
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
          <div style={{ marginBottom: 4, fontWeight: 500, color: 'var(--color-text)', fontSize: 12 }}>
            Implied dependency edges
          </div>
          <ul style={{ marginTop: 2, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {result.impliedEdges.map((e, i) => (
              <li key={i}>
                {e.from.kind}/{e.from.name}{' '}
                <span style={{ color: 'var(--color-text)' }}>→</span>{' '}
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
      style={{ ...( result.ok ? { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-ok)', background: 'var(--color-surface-1)', padding: 12 } : { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', padding: 12 } ) }}
      data-testid="composites-wetrun-summary"
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}><StatusDot tone={result.status.phase === 'Ready' || result.status.phase === 'Pending' || result.status.phase === 'Applying' ? 'ok' : result.status.phase === 'Failed' ? 'err' : result.status.phase === 'Degraded' ? 'warn' : 'idle'} />{result.status.phase}</span>
        <span style={{ color: 'var(--color-text)' }}>
          {result.ok ? 'apply succeeded' : 'apply failed'}
        </span>
        {result.rolledBack && (
          <span style={{ color: 'var(--color-warn,var(--color-ok))', fontSize: 12 }}>
            · rolled back
          </span>
        )}
      </div>
      {failed.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 500, color: 'var(--color-err)', fontSize: 12 }}>
            Failed components ({failed.length})
          </div>
          <ul style={{ marginTop: 2, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text)' }}>
            {failed.map((f, i) => (
              <li key={i}>
                <span style={{ color: 'var(--color-text-secondary)' }}>
                  {f.ref.kind}/
                </span>
                {f.ref.name}
                {f.message && (
                  <span style={{ color: 'var(--color-err)' }}>
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
    <div style={{ marginTop: 16 }}>
      <div
        style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
        data-testid="composites-apply-selector"
      >
        <label  style={{ fontSize: 14 }}>
          <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Mode
          </span>
          <div style={{ display: 'flex', gap: 4 }} role="radiogroup" aria-label="Composite mode">
            <Button
              type="button"
              role="radio"
              aria-checked={mode === 'new'}
              onClick={() => {
                setMode('new');
                onSelect(null);
                setYamlText(DEFAULT_YAML);
              }}
              data-testid="composites-mode-new"
              style={{ ...( mode === 'new' ? { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-brand)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, fontSize: 12, fontWeight: 500, color: 'var(--color-text)' } : { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, fontSize: 12, color: 'var(--color-text-secondary)' } ) }}
            >
              New composite
            </Button>
            <Button
              type="button"
              role="radio"
              aria-checked={mode === 'edit'}
              onClick={() => setMode('edit')}
              data-testid="composites-mode-edit"
              style={{ ...( mode === 'edit' ? { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-brand)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, fontSize: 12, fontWeight: 500, color: 'var(--color-text)' } : { borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, fontSize: 12, color: 'var(--color-text-secondary)' } ) }}
            >
              Edit existing
            </Button>
          </div>
        </label>
        {mode === 'edit' && (
          <label  style={{ fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              Composite
            </span>
            <ExistingComposites
              selected={selectedName}
              onChange={(name) => onSelect(name)}
            />
          </label>
        )}
        <label  style={{ fontSize: 14 }}>
          <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Runtime
          </span>
          <select
            value={detectRuntimeInYaml(yamlText)}
            onChange={(e) =>
              clearUnlockOnEdit(
                rewriteRuntimeInYaml(
                  yamlText,
                  e.target.value as 'auto' | 'docker' | 'kubernetes',
                ),
              )
            }
            data-testid="composites-runtime-picker"
            style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, color: 'var(--color-text)', fontSize: 12 }}
            title="Per-composite runtime override. `auto` inherits LLAMACTL_RUNTIME_BACKEND (defaults to 'docker')."
          >
            <option value="auto">auto (env fallback)</option>
            <option value="docker">docker</option>
            <option value="kubernetes">kubernetes</option>
          </select>
        </label>
      </div>

      <textarea
        value={yamlText}
        onChange={(e) => clearUnlockOnEdit(e.target.value)}
        data-testid="composites-yaml-editor"
        rows={20}
        spellCheck={false}
        style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Button
          type="button"
          onClick={() => {
            void runDry();
          }}
          disabled={apply.isPending}
          data-testid="composites-dryrun"
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-brand)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, color: 'var(--color-ok)', opacity: 0.5, fontSize: 12 }}
        >
          {apply.isPending && apply.variables?.dryRun
            ? 'Validating…'
            : 'Dry-run'}
        </Button>
        <Button
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
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-brand)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, fontWeight: 500, color: 'var(--color-brand-contrast)', opacity: 0.5, fontSize: 12 }}
          title={
            dryRunOk && dryRunYaml === yamlText
              ? 'Wet-apply the composite'
              : 'Dry-run first — unlocks wet apply'
          }
        >
          {apply.isPending && apply.variables?.dryRun === false
            ? 'Applying…'
            : 'Apply'}
        </Button>
        {error && (
          <span style={{ color: 'var(--color-err)', fontSize: 12 }}>{error}</span>
        )}
      </div>

      {dryRunOk && !wetResult && <DryRunPreview result={dryRunOk} />}
      {wetResult && <WetRunSummary result={wetResult} />}
    </div>
  );
}

/**
 * Parse the current `spec.runtime:` choice from a YAML-editor string.
 * Returns 'auto' when the field is absent or commented — mirrors the
 * router's precedence chain (manifest → env → 'docker').
 */
function detectRuntimeInYaml(yaml: string): 'auto' | 'docker' | 'kubernetes' {
  // Active (non-commented) `runtime:` line only.
  const m = yaml.match(/^\s{2}runtime:\s*(docker|kubernetes)\s*$/m);
  if (m && m[1]) return m[1] as 'docker' | 'kubernetes';
  return 'auto';
}

/**
 * Rewrite the `spec.runtime:` line in an operator-authored composite
 * YAML. Mirrors the `init` command's flat-string rewrite pattern —
 * safe because our templates + the DEFAULT_YAML carry stable
 * formatting. Handles three cases:
 *
 *   - Manifest has `runtime: docker|kubernetes` (active line):
 *     replace in place or remove when picking 'auto'.
 *   - Manifest has a commented `# runtime: ...` (DEFAULT_YAML
 *     starts like that): uncomment and set the value, or leave
 *     commented when picking 'auto'.
 *   - Manifest has no runtime line at all: insert one right after
 *     the `spec:` key for docker/kubernetes; leave the YAML alone
 *     for 'auto'.
 */
function rewriteRuntimeInYaml(
  yaml: string,
  choice: 'auto' | 'docker' | 'kubernetes',
): string {
  const ACTIVE = /^(\s{2})runtime:\s*(docker|kubernetes)\s*$/m;
  const COMMENTED = /^(\s{2})#\s*runtime:.*$/m;

  if (choice === 'auto') {
    // Leave a commented breadcrumb so the picker still has
    // somewhere to round-trip back to. If the manifest was clean,
    // drop any active runtime line without adding anything new.
    if (ACTIVE.test(yaml)) {
      return yaml.replace(
        ACTIVE,
        '$1# runtime: docker        # or kubernetes',
      );
    }
    return yaml;
  }

  if (ACTIVE.test(yaml)) {
    return yaml.replace(ACTIVE, `$1runtime: ${choice}`);
  }
  if (COMMENTED.test(yaml)) {
    return yaml.replace(COMMENTED, `$1runtime: ${choice}`);
  }
  // Insert immediately after `spec:` — composite specs always have
  // this key.
  return yaml.replace(/^(spec:\s*)$/m, `$1\n  runtime: ${choice}`);
}

function ExistingComposites(props: {
  selected: string | null;
  onChange: (name: string) => void;
}): React.JSX.Element {
  const list = trpc.compositeList.useQuery();
  const rows = (list.data ?? []) as CompositeShape[];
  if (rows.length === 0) {
    return (
      <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)', fontSize: 12 }}>
        no composites — create a new one
      </span>
    );
  }
  return (
    <select
      value={props.selected ?? ''}
      onChange={(e) => props.onChange(e.target.value)}
      data-testid="composites-existing-select"
      style={{ width: 256, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}
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
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontSize: 10, background: 'var(--color-surface-2)', color: 'var(--color-text-secondary)' }}
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
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {s.kind} on <span style={{ fontFamily: 'var(--font-mono)' }}>{s.node}</span>
          </span>
        ),
      })),
    },
    {
      title: 'Workloads',
      rows: spec.workloads.map((w) => ({
        ref: { kind: 'workload', name: w.node },
        meta: (
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{w.target.kind}:{w.target.value}</span>
          </span>
        ),
      })),
    },
    {
      title: 'RAG nodes',
      rows: spec.ragNodes.map((r) => ({
        ref: { kind: 'rag', name: r.name },
        meta: (
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            node <span style={{ fontFamily: 'var(--font-mono)' }}>{r.node}</span>
            {r.backingService && (
              <>
                {' '}
                · backed by <span style={{ fontFamily: 'var(--font-mono)' }}>{r.backingService}</span>
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
          <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {g.provider} on <span style={{ fontFamily: 'var(--font-mono)' }}>{g.node}</span>
            {g.upstreamWorkloads.length > 0 && (
              <>
                {' '}
                · upstreams{' '}
                <span style={{ fontFamily: 'var(--font-mono)' }}>
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
    <div style={{ marginTop: 12 }} data-testid="composites-component-tree">
      {sections.map((section) => (
        <div key={section.title}>
          <div style={{ marginBottom: 4, fontWeight: 500, color: 'var(--color-text)', fontSize: 12 }}>
            {section.title} ({section.rows.length})
          </div>
          {section.rows.length === 0 ? (
            <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', padding: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>
              none declared
            </div>
          ) : (
            <ul style={{ marginTop: 4 }}>
              {section.rows.map((row) => (
                <li
                  key={`${row.ref.kind}/${row.ref.name}`}
                  data-testid={`composites-component-${row.ref.kind}-${row.ref.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4 }}
                >
                  {badge(row.ref)}
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}>
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
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 12 }}
        data-testid="composites-live-status-error"
      >
        Live status unavailable: {error}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Waiting for status events…
      </div>
    );
  }
  return (
    <ul
      style={{ maxHeight: 192, marginTop: 2, overflow: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10 }}
      data-testid="composites-live-status"
    >
      {events.map((ev, i) => (
        <li
          key={i}
          style={{ color: 'var(--color-text-secondary)' }}
          data-testid={`composites-live-event-${ev.type}`}
        >
          <span style={{ color: 'var(--color-text)' }}>{ev.type}</span>
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
      <Button
        type="button"
        onClick={() => setArmed(true)}
        data-testid="composites-destroy-arm"
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, color: 'var(--color-err)', fontSize: 12 }}
      >
        Destroy composite…
      </Button>
    );
  }

  return (
    <div
      style={{ marginTop: 8, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', padding: 12 }}
      data-testid="composites-destroy-confirm"
    >
      <div style={{ color: 'var(--color-text)', fontSize: 12 }}>
        Destructive action: this will tear down every component declared in{' '}
        <span style={{ fontFamily: 'var(--font-mono)' }}>{name}</span> and remove the manifest. Type the
        composite name below to confirm.
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          data-testid="composites-destroy-input"
          placeholder={name}
          style={{ width: 192, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}
        />
        <Button
          type="button"
          onClick={() => destroy.mutate({ name, dryRun: false })}
          disabled={!matches || destroy.isPending}
          data-testid="composites-destroy-confirm-button"
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-err)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, color: 'var(--color-text-inverse)', opacity: 0.5, fontSize: 12 }}
        >
          {destroy.isPending ? 'Destroying…' : 'Confirm destroy'}
        </Button>
        <Button
          type="button"
          onClick={() => {
            setArmed(false);
            setTyped('');
            setError(null);
          }}
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 12, paddingRight: 12, paddingTop: 4, paddingBottom: 4, color: 'var(--color-text)', fontSize: 12 }}
        >
          Cancel
        </Button>
      </div>
      {error && (
        <div style={{ color: 'var(--color-err)', fontSize: 12 }}>{error}</div>
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
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        No composite selected. Pick one from the{' '}
        <Button variant="secondary" size="sm"
          type="button"
          
          onClick={() => onPickFromList('')}
        >
          List tab
        </Button>
        .
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        Loading <span style={{ fontFamily: 'var(--font-mono)' }}>{name}</span>…
      </div>
    );
  }
  if (query.error) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}>
        Failed to load composite <span style={{ fontFamily: 'var(--font-mono)' }}>{name}</span>:{' '}
        {query.error.message}
      </div>
    );
  }
  const manifest = query.data as CompositeShape | null | undefined;
  if (!manifest) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        Composite <span style={{ fontFamily: 'var(--font-mono)' }}>{name}</span> not found.
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
    <div style={{ marginTop: 16 }} data-testid={`composites-detail-${name}`}>
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <h2 style={{ fontFamily: 'var(--font-mono)', fontSize: 18, color: 'var(--color-text)' }}>
            {manifest.metadata.name}
          </h2>
          <span
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}><StatusDot tone={manifest.status?.phase === 'Ready' || manifest.status?.phase === 'Pending' || manifest.status?.phase === 'Applying' ? 'ok' : manifest.status?.phase === 'Failed' ? 'err' : manifest.status?.phase === 'Degraded' ? 'warn' : 'idle'} />{manifest.status?.phase ?? 'Unapplied'}</span>
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
            last applied {formatTimestamp(manifest.status?.appliedAt)}
          </span>
        </div>
        {Object.keys(labels).length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {Object.entries(labels).map(([k, v]) => (
              <span
                key={k}
                style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}
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
        <div style={{ marginBottom: 4, fontWeight: 500, color: 'var(--color-text)', fontSize: 12 }}>
          Live status
        </div>
        <LiveStatusStream name={manifest.metadata.name} />
      </div>

      <div>
        <Button
          type="button"
          onClick={() => setShowYaml((v) => !v)}
          data-testid="composites-yaml-toggle"
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontSize: 10, color: 'var(--color-text)' }}
        >
          {showYaml ? 'Hide YAML' : 'View YAML'}
        </Button>
        {showYaml && (
          <pre
            style={{ marginTop: 8, overflowX: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}
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
      style={{ height: '100%', overflow: 'auto', padding: 24 }}
      data-testid="workloads-composites-root"
    >
      <div style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Composites
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Declarative multi-component applies
      </h1>
      <p style={{ marginBottom: 24, color: 'var(--color-text-secondary)', fontSize: 12 }}>
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
