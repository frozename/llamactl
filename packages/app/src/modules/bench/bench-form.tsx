import * as React from "react";

import { Button, Input } from "@/ui";

import type { Mode } from "./types";

function TargetField({
  target,
  setTarget,
  busy,
  rels,
}: {
  target: string;
  setTarget: (v: string) => void;
  busy: boolean;
  rels: string[];
}): React.JSX.Element {
  return (
    <label style={{ gridColumn: "span 7 / span 7", fontSize: 14 }}>
      <span
        style={{
          marginBottom: 4,
          display: "block",
          fontSize: 12,
          color: "var(--color-text-secondary)",
        }}
      >
        Target (rel or preset alias)
      </span>
      <Input
        list="bench-rel-suggestions"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value);
        }}
        disabled={busy}
        data-testid="bench-target"
        style={{ width: "100%", fontFamily: "monospace" }}
        placeholder="current | best | <rel>"
      />
      <datalist id="bench-rel-suggestions">
        {["current", "best", "vision", "balanced", "fast"].map((alias) => (
          <option key={alias} value={alias} />
        ))}
        {rels.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
    </label>
  );
}

function ModeField({
  mode,
  setMode,
  busy,
}: {
  mode: Mode;
  setMode: (v: Mode) => void;
  busy: boolean;
}): React.JSX.Element {
  return (
    <label style={{ gridColumn: "span 2 / span 2", fontSize: 14 }}>
      <span
        style={{
          marginBottom: 4,
          display: "block",
          fontSize: 12,
          color: "var(--color-text-secondary)",
        }}
      >
        Mode
      </span>
      <select
        value={mode}
        onChange={(e) => {
          setMode(e.target.value as Mode);
        }}
        disabled={busy}
        style={{
          width: "100%",
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-2)",
          padding: "4px 8px",
          fontFamily: "monospace",
          color: "var(--color-text)",
        }}
      >
        <option value="auto">auto</option>
        <option value="text">text</option>
        <option value="vision">vision</option>
      </select>
    </label>
  );
}

function FormActions({
  busy,
  canRun,
  onStart,
  onCancel,
}: {
  busy: boolean;
  canRun: boolean;
  onStart: (kind: "preset" | "vision") => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        gridColumn: "span 3 / span 3",
        display: "flex",
        alignItems: "flex-end",
        gap: 8,
      }}
    >
      {busy ? (
        <Button
          variant="destructive"
          onClick={() => {
            onCancel();
          }}
          data-testid="bench-cancel"
          style={{ flex: 1 }}
        >
          Cancel
        </Button>
      ) : (
        <>
          <Button
            variant="primary"
            onClick={() => {
              onStart("preset");
            }}
            disabled={!canRun}
            data-testid="bench-run-preset"
            style={{ flex: 1 }}
          >
            Run preset
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onStart("vision");
            }}
            disabled={!canRun}
            data-testid="bench-run-vision"
            style={{ flex: 1 }}
          >
            Run vision
          </Button>
        </>
      )}
    </div>
  );
}

export function BenchForm(props: {
  target: string;
  setTarget: (v: string) => void;
  mode: Mode;
  setMode: (v: Mode) => void;
  busy: boolean;
  canRun: boolean;
  rels: string[];
  onStart: (kind: "preset" | "vision") => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { target, setTarget, mode, setMode, busy, canRun, rels, onStart, onCancel } = props;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      style={{
        marginBottom: 16,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
        <TargetField target={target} setTarget={setTarget} busy={busy} rels={rels} />
        <ModeField mode={mode} setMode={setMode} busy={busy} />
        <FormActions busy={busy} canRun={canRun} onStart={onStart} onCancel={onCancel} />
      </div>
    </form>
  );
}
