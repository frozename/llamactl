import * as React from 'react';
import { useMemo, useState } from 'react';
import { stringify as stringifyYaml } from 'yaml';
import { trpc } from '@/lib/trpc';

/**
 * Pipeline wizard modal. Four-step stepper that assembles a
 * RagPipeline manifest from form state:
 *
 *   1. Destination  — name + rag node + collection
 *   2. Sources      — one or more filesystem/http/git source cards
 *   3. Transforms   — markdown-chunk defaults (chunk_size/overlap/
 *                     preserve_headings); single transform in v1
 *   4. Review       — computed YAML preview + Apply button
 *
 * State lives entirely in React — no in-flight tRPC until Apply.
 * The Review step serializes to YAML client-side via the `yaml`
 * library already in the app bundle; schema validation happens
 * server-side when \`ragPipelineApply\` parses the YAML (errors
 * surface in the modal so the operator can step back and fix).
 *
 * Design notes:
 *   - No save-as-draft / resume-later in v1. Closing the modal
 *     discards the form. Revisit if operators ask.
 *   - Source kind switching preserves shared fields (tag) but
 *     resets kind-specific ones so we don't carry stale state.
 */

type SourceKind = 'filesystem' | 'http' | 'git';

interface FilesystemSource {
  kind: 'filesystem';
  root: string;
  glob: string;
  tag?: string;
}

interface HttpSource {
  kind: 'http';
  url: string;
  max_depth: number;
  same_origin: boolean;
  ignore_robots: boolean;
  rate_limit_per_sec: number;
  timeout_ms: number;
  tokenRef?: string;
  tag?: string;
}

interface GitSource {
  kind: 'git';
  repo: string;
  ref?: string;
  subpath?: string;
  glob: string;
  tokenRef?: string;
  tag?: string;
}

type SourceState = FilesystemSource | HttpSource | GitSource;

interface TransformState {
  chunk_size: number;
  overlap: number;
  preserve_headings: boolean;
}

interface FormState {
  name: string;
  ragNode: string;
  collection: string;
  sources: SourceState[];
  transform: TransformState;
  schedule: string;
  on_duplicate: 'skip' | 'replace' | 'version';
}

type Step = 'destination' | 'sources' | 'transforms' | 'review';

const STEPS: Array<{ id: Step; label: string }> = [
  { id: 'destination', label: 'Destination' },
  { id: 'sources', label: 'Sources' },
  { id: 'transforms', label: 'Transforms' },
  { id: 'review', label: 'Review' },
];

function emptySource(kind: SourceKind): SourceState {
  if (kind === 'filesystem') {
    return { kind: 'filesystem', root: '', glob: '**/*.md' };
  }
  if (kind === 'http') {
    return {
      kind: 'http',
      url: '',
      max_depth: 2,
      same_origin: true,
      ignore_robots: false,
      rate_limit_per_sec: 2,
      timeout_ms: 10_000,
    };
  }
  return { kind: 'git', repo: '', glob: '**/*.md' };
}

function parseTagString(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fallback: k=v,k=v string form.
    const out: Record<string, string> = {};
    for (const pair of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
      const eq = pair.indexOf('=');
      if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
    if (Object.keys(out).length > 0) return out;
  }
  return undefined;
}

function buildManifest(form: FormState): unknown {
  const spec: Record<string, unknown> = {
    destination: {
      ragNode: form.ragNode.trim(),
      collection: form.collection.trim(),
    },
    sources: form.sources.map((s) => buildSource(s)),
    transforms: [
      {
        kind: 'markdown-chunk',
        chunk_size: form.transform.chunk_size,
        overlap: form.transform.overlap,
        preserve_headings: form.transform.preserve_headings,
      },
    ],
    on_duplicate: form.on_duplicate,
  };
  if (form.schedule.trim()) spec.schedule = form.schedule.trim();
  return {
    apiVersion: 'llamactl/v1',
    kind: 'RagPipeline',
    metadata: { name: form.name.trim() },
    spec,
  };
}

function buildSource(s: SourceState): Record<string, unknown> {
  if (s.kind === 'filesystem') {
    const out: Record<string, unknown> = {
      kind: 'filesystem',
      root: s.root.trim(),
      glob: s.glob.trim() || '**/*',
    };
    const tag = s.tag ? parseTagString(s.tag) : undefined;
    if (tag) out.tag = tag;
    return out;
  }
  if (s.kind === 'http') {
    const out: Record<string, unknown> = {
      kind: 'http',
      url: s.url.trim(),
      max_depth: s.max_depth,
      same_origin: s.same_origin,
      ignore_robots: s.ignore_robots,
      rate_limit_per_sec: s.rate_limit_per_sec,
      timeout_ms: s.timeout_ms,
    };
    if (s.tokenRef?.trim()) out.auth = { tokenRef: s.tokenRef.trim() };
    const tag = s.tag ? parseTagString(s.tag) : undefined;
    if (tag) out.tag = tag;
    return out;
  }
  const out: Record<string, unknown> = {
    kind: 'git',
    repo: s.repo.trim(),
    glob: s.glob.trim() || '**/*.md',
  };
  if (s.ref?.trim()) out.ref = s.ref.trim();
  if (s.subpath?.trim()) out.subpath = s.subpath.trim();
  if (s.tokenRef?.trim()) out.auth = { tokenRef: s.tokenRef.trim() };
  const tag = s.tag ? parseTagString(s.tag) : undefined;
  if (tag) out.tag = tag;
  return out;
}

function validate(form: FormState): string[] {
  const errs: string[] = [];
  if (!form.name.trim()) errs.push('name is required');
  if (!form.ragNode.trim()) errs.push('destination.ragNode is required');
  if (!form.collection.trim()) errs.push('destination.collection is required');
  if (form.sources.length === 0) errs.push('at least one source is required');
  for (const [i, s] of form.sources.entries()) {
    if (s.kind === 'filesystem' && !s.root.trim()) {
      errs.push(`sources[${i}].root is required`);
    }
    if (s.kind === 'http' && !s.url.trim()) {
      errs.push(`sources[${i}].url is required`);
    }
    if (s.kind === 'git' && !s.repo.trim()) {
      errs.push(`sources[${i}].repo is required`);
    }
  }
  return errs;
}

export function PipelineWizardModal(props: {
  open: boolean;
  onClose: () => void;
  onApplied: (name: string) => void;
  availableRagNodes: string[];
  defaultRagNode: string;
}): React.JSX.Element | null {
  const { open, onClose, onApplied, availableRagNodes, defaultRagNode } = props;
  const utils = trpc.useUtils();
  const [step, setStep] = useState<Step>('destination');
  const [form, setForm] = useState<FormState>(() => ({
    name: '',
    ragNode: defaultRagNode,
    collection: '',
    sources: [emptySource('filesystem')],
    transform: { chunk_size: 800, overlap: 150, preserve_headings: true },
    schedule: '',
    on_duplicate: 'skip',
  }));
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const errors = useMemo(() => validate(form), [form]);
  const yaml = useMemo(() => {
    try {
      return stringifyYaml(buildManifest(form));
    } catch (err) {
      return `# failed to render: ${(err as Error).message}`;
    }
  }, [form]);

  const applyMut = trpc.ragPipelineApply.useMutation({
    onSuccess: async (data) => {
      setApplyError(null);
      setApplying(false);
      await utils.ragPipelineList.invalidate();
      onApplied(data.name);
    },
    onError: (err) => {
      setApplyError(err.message);
      setApplying(false);
    },
  });

  if (!open) return null;

  const currentIdx = STEPS.findIndex((s) => s.id === step);
  const canAdvance = errors.length === 0 || step !== 'review';

  const updateSource = (idx: number, patch: Partial<SourceState>): void => {
    setForm((f) => ({
      ...f,
      sources: f.sources.map((s, i) => {
        if (i !== idx) return s;
        // Kind change: replace with a fresh source of that kind, but
        // carry the tag across since it's shape-agnostic.
        if (patch.kind && patch.kind !== s.kind) {
          const fresh = emptySource(patch.kind);
          return { ...fresh, tag: (s as { tag?: string }).tag } as SourceState;
        }
        return { ...s, ...patch } as SourceState;
      }),
    }));
  };

  const removeSource = (idx: number): void => {
    setForm((f) => ({
      ...f,
      sources: f.sources.filter((_, i) => i !== idx),
    }));
  };

  const addSource = (kind: SourceKind): void => {
    setForm((f) => ({ ...f, sources: [...f.sources, emptySource(kind)] }));
  };

  const onApply = (): void => {
    setApplyError(null);
    setApplying(true);
    try {
      const yamlStr = stringifyYaml(buildManifest(form));
      applyMut.mutate({ manifestYaml: yamlStr });
    } catch (err) {
      setApplyError((err as Error).message);
      setApplying(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      data-testid="pipeline-wizard-modal"
    >
      <div className="w-full max-w-4xl rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] shadow-xl">
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
              New RAG Pipeline
            </div>
            <div className="mono text-sm text-[color:var(--color-text)]">
              {form.name || '<unnamed>'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-testid="pipeline-wizard-close"
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
          >
            Close
          </button>
        </div>

        {/* Stepper indicator */}
        <div className="flex gap-1 border-b border-[var(--color-border)] px-4 py-2">
          {STEPS.map((s, i) => {
            const active = s.id === step;
            const done = i < currentIdx;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                data-testid={`pipeline-wizard-step-${s.id}`}
                className={
                  active
                    ? 'rounded bg-[var(--color-brand)] px-2 py-1 text-xs font-medium text-[color:var(--color-surface-0)]'
                    : done
                      ? 'rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-text)]'
                      : 'rounded border border-transparent px-2 py-1 text-xs text-[color:var(--color-text-secondary)]'
                }
              >
                {i + 1}. {s.label}
              </button>
            );
          })}
        </div>

        <div className="max-h-[60vh] overflow-auto p-4">
          {step === 'destination' && (
            <DestinationStep
              form={form}
              setForm={setForm}
              availableRagNodes={availableRagNodes}
            />
          )}
          {step === 'sources' && (
            <SourcesStep
              sources={form.sources}
              onUpdate={updateSource}
              onRemove={removeSource}
              onAdd={addSource}
            />
          )}
          {step === 'transforms' && (
            <TransformsStep
              transform={form.transform}
              onChange={(t) => setForm((f) => ({ ...f, transform: t }))}
              schedule={form.schedule}
              onScheduleChange={(v) => setForm((f) => ({ ...f, schedule: v }))}
              onDuplicate={form.on_duplicate}
              onOnDuplicateChange={(v) =>
                setForm((f) => ({ ...f, on_duplicate: v }))
              }
            />
          )}
          {step === 'review' && (
            <ReviewStep yaml={yaml} errors={errors} applyError={applyError} />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] px-4 py-3">
          <div className="text-xs text-[color:var(--color-text-secondary)]">
            {errors.length > 0 && (
              <span className="text-[color:var(--color-err)]">
                {errors.length} issue{errors.length === 1 ? '' : 's'} to fix
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                const prev = STEPS[currentIdx - 1];
                if (prev) setStep(prev.id);
              }}
              disabled={currentIdx === 0}
              data-testid="pipeline-wizard-back"
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Back
            </button>
            {step !== 'review' ? (
              <button
                type="button"
                onClick={() => {
                  const next = STEPS[currentIdx + 1];
                  if (next) setStep(next.id);
                }}
                disabled={!canAdvance}
                data-testid="pipeline-wizard-next"
                className="rounded bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={onApply}
                disabled={applying || errors.length > 0}
                data-testid="pipeline-wizard-apply"
                className="rounded bg-[var(--color-brand)] px-3 py-1 text-xs font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {applying ? 'Applying…' : 'Apply'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DestinationStep(props: {
  form: FormState;
  setForm: (patch: (f: FormState) => FormState) => void;
  availableRagNodes: string[];
}): React.JSX.Element {
  const { form, setForm, availableRagNodes } = props;
  return (
    <div className="space-y-3" data-testid="pipeline-wizard-destination">
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
          Pipeline name
        </span>
        <input
          type="text"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. llamactl-docs"
          data-testid="pipeline-wizard-name"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
          RAG node
        </span>
        <select
          value={form.ragNode}
          onChange={(e) => setForm((f) => ({ ...f, ragNode: e.target.value }))}
          data-testid="pipeline-wizard-ragnode"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
        >
          <option value="">(select a node)</option>
          {availableRagNodes.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
          Collection
        </span>
        <input
          type="text"
          value={form.collection}
          onChange={(e) => setForm((f) => ({ ...f, collection: e.target.value }))}
          placeholder="e.g. llamactl_docs"
          data-testid="pipeline-wizard-collection"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
        />
      </label>
    </div>
  );
}

function SourceEditor(props: {
  idx: number;
  source: SourceState;
  onUpdate: (patch: Partial<SourceState>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { idx, source, onUpdate, onRemove } = props;
  return (
    <div
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid={`pipeline-wizard-source-${idx}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <label className="flex items-baseline gap-2 text-sm">
          <span className="text-xs text-[color:var(--color-text-secondary)]">Kind</span>
          <select
            value={source.kind}
            onChange={(e) =>
              onUpdate({ kind: e.target.value as SourceKind } as Partial<SourceState>)
            }
            data-testid={`pipeline-wizard-source-kind-${idx}`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 mono text-xs text-[color:var(--color-text)]"
          >
            <option value="filesystem">filesystem</option>
            <option value="http">http</option>
            <option value="git">git</option>
          </select>
        </label>
        <button
          type="button"
          onClick={onRemove}
          data-testid={`pipeline-wizard-source-remove-${idx}`}
          className="rounded border border-[var(--color-err)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-err)] hover:opacity-90"
        >
          Remove
        </button>
      </div>
      {source.kind === 'filesystem' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Root path
            </span>
            <input
              type="text"
              value={source.root}
              onChange={(e) => onUpdate({ root: e.target.value })}
              placeholder="/path/to/docs"
              data-testid={`pipeline-wizard-source-root-${idx}`}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Glob
            </span>
            <input
              type="text"
              value={source.glob}
              onChange={(e) => onUpdate({ glob: e.target.value })}
              data-testid={`pipeline-wizard-source-glob-${idx}`}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
        </div>
      )}
      {source.kind === 'http' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              URL
            </span>
            <input
              type="text"
              value={source.url}
              onChange={(e) => onUpdate({ url: e.target.value })}
              placeholder="https://docs.example.com"
              data-testid={`pipeline-wizard-source-url-${idx}`}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Max depth
            </span>
            <input
              type="number"
              min={0}
              max={5}
              value={source.max_depth}
              onChange={(e) =>
                onUpdate({ max_depth: Math.max(0, Math.min(5, Number(e.target.value) || 0)) })
              }
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Rate limit (req/s)
            </span>
            <input
              type="number"
              min={1}
              max={20}
              value={source.rate_limit_per_sec}
              onChange={(e) =>
                onUpdate({
                  rate_limit_per_sec: Math.max(1, Number(e.target.value) || 2),
                })
              }
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="col-span-2 flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={source.same_origin}
              onChange={(e) => onUpdate({ same_origin: e.target.checked })}
            />
            Same-origin only
          </label>
          <label className="col-span-2 flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={source.ignore_robots}
              onChange={(e) => onUpdate({ ignore_robots: e.target.checked })}
            />
            Ignore robots.txt (use only if you own the site)
          </label>
        </div>
      )}
      {source.kind === 'git' && (
        <div className="grid grid-cols-2 gap-2">
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Repo URL
            </span>
            <input
              type="text"
              value={source.repo}
              onChange={(e) => onUpdate({ repo: e.target.value })}
              placeholder="https://github.com/acme/docs.git"
              data-testid={`pipeline-wizard-source-repo-${idx}`}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Ref (optional)
            </span>
            <input
              type="text"
              value={source.ref ?? ''}
              onChange={(e) => onUpdate({ ref: e.target.value })}
              placeholder="main"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Subpath (optional)
            </span>
            <input
              type="text"
              value={source.subpath ?? ''}
              onChange={(e) => onUpdate({ subpath: e.target.value })}
              placeholder="docs"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="col-span-2 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Glob
            </span>
            <input
              type="text"
              value={source.glob}
              onChange={(e) => onUpdate({ glob: e.target.value })}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
        </div>
      )}
    </div>
  );
}

function SourcesStep(props: {
  sources: SourceState[];
  onUpdate: (idx: number, patch: Partial<SourceState>) => void;
  onRemove: (idx: number) => void;
  onAdd: (kind: SourceKind) => void;
}): React.JSX.Element {
  const { sources, onUpdate, onRemove, onAdd } = props;
  return (
    <div className="space-y-3" data-testid="pipeline-wizard-sources">
      {sources.map((s, i) => (
        <SourceEditor
          key={i}
          idx={i}
          source={s}
          onUpdate={(patch) => onUpdate(i, patch)}
          onRemove={() => onRemove(i)}
        />
      ))}
      <div className="flex gap-2">
        {(['filesystem', 'http', 'git'] as SourceKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onAdd(k)}
            data-testid={`pipeline-wizard-source-add-${k}`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-xs text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text)]"
          >
            + {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function TransformsStep(props: {
  transform: TransformState;
  onChange: (t: TransformState) => void;
  schedule: string;
  onScheduleChange: (v: string) => void;
  onDuplicate: 'skip' | 'replace' | 'version';
  onOnDuplicateChange: (v: 'skip' | 'replace' | 'version') => void;
}): React.JSX.Element {
  const { transform, onChange, schedule, onScheduleChange, onDuplicate, onOnDuplicateChange } = props;
  return (
    <div className="space-y-4" data-testid="pipeline-wizard-transforms">
      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
          Chunking (markdown-chunk)
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Chunk size (chars)
            </span>
            <input
              type="number"
              min={100}
              max={8000}
              value={transform.chunk_size}
              onChange={(e) =>
                onChange({ ...transform, chunk_size: Math.max(100, Number(e.target.value) || 800) })
              }
              data-testid="pipeline-wizard-chunk-size"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Overlap (chars)
            </span>
            <input
              type="number"
              min={0}
              max={2000}
              value={transform.overlap}
              onChange={(e) =>
                onChange({ ...transform, overlap: Math.max(0, Number(e.target.value) || 0) })
              }
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="flex items-end gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={transform.preserve_headings}
              onChange={(e) => onChange({ ...transform, preserve_headings: e.target.checked })}
            />
            Preserve heading context
          </label>
        </div>
      </div>
      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
          Schedule + dedupe
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Schedule (optional)
            </span>
            <input
              type="text"
              value={schedule}
              onChange={(e) => onScheduleChange(e.target.value)}
              placeholder="@daily / @hourly / @every 15m"
              data-testid="pipeline-wizard-schedule"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              On duplicate
            </span>
            <select
              value={onDuplicate}
              onChange={(e) =>
                onOnDuplicateChange(e.target.value as 'skip' | 'replace' | 'version')
              }
              data-testid="pipeline-wizard-on-duplicate"
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            >
              <option value="skip">skip</option>
              <option value="replace">replace</option>
              <option value="version">version</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

function ReviewStep(props: {
  yaml: string;
  errors: string[];
  applyError: string | null;
}): React.JSX.Element {
  const { yaml, errors, applyError } = props;
  return (
    <div className="space-y-3" data-testid="pipeline-wizard-review">
      {errors.length > 0 && (
        <ul
          className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] p-3 text-xs text-[color:var(--color-err)]"
          data-testid="pipeline-wizard-errors"
        >
          {errors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}
      {applyError && (
        <div
          className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]"
          data-testid="pipeline-wizard-apply-error"
        >
          {applyError}
        </div>
      )}
      <pre
        className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mono text-[10px] text-[color:var(--color-text)]"
        data-testid="pipeline-wizard-yaml"
      >
        {yaml}
      </pre>
    </div>
  );
}
