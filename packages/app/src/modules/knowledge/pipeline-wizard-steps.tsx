import * as React from "react";

import type { FormState, SourceKind, SourceState, TransformState } from "./pipeline-types";

import { SourceEditor } from "./source-editor";

export function DestinationStep(props: {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
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
          onChange={(e) => {
            setForm((f) => ({ ...f, name: e.target.value }));
          }}
          placeholder="e.g. llamactl-docs"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
          RAG node
        </span>
        <select
          value={form.ragNode}
          onChange={(e) => {
            setForm((f) => ({ ...f, ragNode: e.target.value }));
          }}
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
          onChange={(e) => {
            setForm((f) => ({ ...f, collection: e.target.value }));
          }}
          placeholder="e.g. llamactl_docs"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-[color:var(--color-text)]"
        />
      </label>
    </div>
  );
}

export function SourcesStep(props: {
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
          onUpdate={(patch) => {
            onUpdate(i, patch);
          }}
          onRemove={() => {
            onRemove(i);
          }}
        />
      ))}
      <div className="flex gap-2">
        {(["filesystem", "http", "git"] as SourceKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => {
              onAdd(k);
            }}
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

export function TransformsStep(props: {
  transform: TransformState;
  onChange: (t: TransformState) => void;
  schedule: string;
  onScheduleChange: (v: string) => void;
  onDuplicate: "skip" | "replace" | "version";
  onOnDuplicateChange: (v: "skip" | "replace" | "version") => void;
}): React.JSX.Element {
  const { transform, onChange, schedule, onScheduleChange, onDuplicate, onOnDuplicateChange } =
    props;
  return (
    <div className="space-y-4" data-testid="pipeline-wizard-transforms">
      <div>
        <div className="mb-2 text-xs uppercase tracking-wider text-[color:var(--color-text-secondary)]">
          Chunking (markdown-chunk)
        </div>
        <div className="grid grid-cols-3 gap-2">
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Chunk size
            </span>
            <input
              type="number"
              min={100}
              max={8000}
              value={transform.chunk_size}
              onChange={(e) => {
                onChange({
                  ...transform,
                  chunk_size: Math.max(100, Number(e.target.value) || 800),
                });
              }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Overlap
            </span>
            <input
              type="number"
              min={0}
              max={2000}
              value={transform.overlap}
              onChange={(e) => {
                onChange({ ...transform, overlap: Math.max(0, Number(e.target.value) || 0) });
              }}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
            />
          </label>
          <label className="flex items-end gap-2 text-xs text-[color:var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={transform.preserve_headings}
              onChange={(e) => {
                onChange({ ...transform, preserve_headings: e.target.checked });
              }}
            />
            Preserve headings
          </label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
            Schedule
          </span>
          <input
            type="text"
            value={schedule}
            onChange={(e) => {
              onScheduleChange(e.target.value);
            }}
            placeholder="@daily"
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
            On duplicate
          </span>
          <select
            value={onDuplicate}
            onChange={(e) => {
              onOnDuplicateChange(e.target.value as "skip" | "replace" | "version");
            }}
            className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]"
          >
            <option value="skip">skip</option>
            <option value="replace">replace</option>
            <option value="version">version</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export function ReviewStep(props: {
  yaml: string;
  errors: string[];
  applyError: string | null;
}): React.JSX.Element {
  const { yaml, errors, applyError } = props;
  return (
    <div className="space-y-3" data-testid="pipeline-wizard-review">
      {errors.length > 0 && (
        <ul className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] p-3 text-xs text-[color:var(--color-err)]">
          {errors.map((e, i) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      )}
      {applyError && (
        <div className="rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {applyError}
        </div>
      )}
      <pre className="overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-3 mono text-[10px] text-[color:var(--color-text)]">
        {yaml}
      </pre>
    </div>
  );
}
