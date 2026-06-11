import * as React from "react";
import type {
  FilesystemSource,
  GitSource,
  HttpSource,
  SourceState,
  SourceKind,
} from "./pipeline-types";

const FIELD_CLS =
  "w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono text-xs text-[color:var(--color-text)]";
const LABEL_CLS = "mb-1 block text-xs text-[color:var(--color-text-secondary)]";

function FilesystemFields(props: {
  source: FilesystemSource;
  onUpdate: (patch: Partial<SourceState>) => void;
}): React.JSX.Element {
  const { source, onUpdate } = props;
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="text-sm">
        <span className={LABEL_CLS}>Root path</span>
        <input
          type="text"
          value={source.root}
          onChange={(e) => {
            onUpdate({ root: e.target.value });
          }}
          placeholder="/path/to/docs"
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm">
        <span className={LABEL_CLS}>Glob</span>
        <input
          type="text"
          value={source.glob}
          onChange={(e) => {
            onUpdate({ glob: e.target.value });
          }}
          className={FIELD_CLS}
        />
      </label>
    </div>
  );
}

function HttpFields(props: {
  source: HttpSource;
  onUpdate: (patch: Partial<SourceState>) => void;
}): React.JSX.Element {
  const { source, onUpdate } = props;
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="col-span-2 text-sm">
        <span className={LABEL_CLS}>URL</span>
        <input
          type="text"
          value={source.url}
          onChange={(e) => {
            onUpdate({ url: e.target.value });
          }}
          placeholder="https://docs.example.com"
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm">
        <span className={LABEL_CLS}>Max depth</span>
        <input
          type="number"
          min={0}
          max={5}
          value={source.max_depth}
          onChange={(e) => {
            onUpdate({ max_depth: Math.max(0, Math.min(5, Number(e.target.value) || 0)) });
          }}
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm">
        <span className={LABEL_CLS}>Rate limit</span>
        <input
          type="number"
          min={1}
          max={20}
          value={source.rate_limit_per_sec}
          onChange={(e) => {
            onUpdate({ rate_limit_per_sec: Math.max(1, Number(e.target.value) || 2) });
          }}
          className={FIELD_CLS}
        />
      </label>
    </div>
  );
}

function GitFields(props: {
  source: GitSource;
  onUpdate: (patch: Partial<SourceState>) => void;
}): React.JSX.Element {
  const { source, onUpdate } = props;
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="col-span-2 text-sm">
        <span className={LABEL_CLS}>Repo URL</span>
        <input
          type="text"
          value={source.repo}
          onChange={(e) => {
            onUpdate({ repo: e.target.value });
          }}
          placeholder="https://github.com/acme/docs.git"
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm">
        <span className={LABEL_CLS}>Ref</span>
        <input
          type="text"
          value={source.ref ?? ""}
          onChange={(e) => {
            onUpdate({ ref: e.target.value });
          }}
          placeholder="main"
          className={FIELD_CLS}
        />
      </label>
      <label className="text-sm">
        <span className={LABEL_CLS}>Glob</span>
        <input
          type="text"
          value={source.glob}
          onChange={(e) => {
            onUpdate({ glob: e.target.value });
          }}
          className={FIELD_CLS}
        />
      </label>
    </div>
  );
}

export function SourceEditor(props: {
  idx: number;
  source: SourceState;
  onUpdate: (patch: Partial<SourceState>) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const { idx, source, onUpdate, onRemove } = props;
  return (
    <div
      className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3"
      data-testid={`pipeline-wizard-source-${String(idx)}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <label className="flex items-baseline gap-2 text-sm">
          <span className="text-xs text-[color:var(--color-text-secondary)]">Kind</span>
          <select
            value={source.kind}
            onChange={(e) => {
              onUpdate({ kind: e.target.value as SourceKind });
            }}
            data-testid={`pipeline-wizard-source-kind-${String(idx)}`}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-0.5 mono text-xs text-[color:var(--color-text)]"
          >
            <option value="filesystem">filesystem</option>
            <option value="http">http</option>
            <option value="git">git</option>
          </select>
        </label>
        <button
          type="button"
          onClick={() => {
            onRemove();
          }}
          data-testid={`pipeline-wizard-source-remove-${String(idx)}`}
          className="rounded border border-[var(--color-err)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] text-[color:var(--color-err)] hover:opacity-90"
        >
          Remove
        </button>
      </div>
      {source.kind === "filesystem" && <FilesystemFields source={source} onUpdate={onUpdate} />}
      {source.kind === "http" && <HttpFields source={source} onUpdate={onUpdate} />}
      {source.kind === "git" && <GitFields source={source} onUpdate={onUpdate} />}
    </div>
  );
}
