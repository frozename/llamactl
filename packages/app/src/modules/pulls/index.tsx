import * as React from "react";

import { Button, EditorialHero, Input } from "@/ui";

import { PullCard } from "./pull-card";
import { type Mode, type Profile, PROFILES } from "./types";
import { usePulls, type UsePullsReturn } from "./use-pulls";

/**
 * Pulls module — Download and test models.
 */

export default function Pulls(): React.JSX.Element {
  const pullsObj = usePulls();
  const { error, activeCount } = pullsObj;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="models-pulls-root">
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Pulls
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        Download a model
      </h1>

      <PullForm pullsObj={pullsObj} />

      {error && <PullsError error={error} />}

      <section>
        <h2
          style={{
            marginBottom: 8,
            fontSize: 14,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            color: "var(--color-text-secondary)",
          }}
        >
          Queue ({activeCount})
        </h2>
        <PullQueue pullsObj={pullsObj} />
      </section>
    </div>
  );
}

function PullForm({ pullsObj }: { pullsObj: UsePullsReturn }): React.JSX.Element {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        pullsObj.enqueue();
      }}
      style={{
        marginBottom: 16,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <PullModeTabs pullsObj={pullsObj} />
      <PullInputs pullsObj={pullsObj} />
      <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-text-secondary)" }}>
        Each Enqueue adds a new card below — runs are independent and can be cancelled individually.
      </div>
    </form>
  );
}

function PullModeTabs({ pullsObj }: { pullsObj: UsePullsReturn }): React.JSX.Element {
  const { mode, setMode } = pullsObj;
  return (
    <div style={{ marginBottom: 12, display: "flex", gap: 4, fontSize: 12 }} role="tablist">
      {(["file", "candidate", "test"] as Mode[]).map((m) => {
        const isActive = mode === m;
        return (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={isActive}
            data-testid={`pulls-mode-${m}`}
            data-active={isActive ? "true" : "false"}
            onClick={() => {
              setMode(m);
            }}
            style={{
              borderRadius: 4,
              border: isActive ? "1px solid var(--color-brand)" : "1px solid transparent",
              backgroundColor: isActive ? "var(--color-surface-2)" : "transparent",
              padding: "4px 12px",
              fontWeight: isActive ? 500 : 400,
              color: isActive ? "var(--color-text)" : "var(--color-text-secondary)",
              cursor: "pointer",
            }}
          >
            {m === "file" ? "Pull file" : m === "candidate" ? "Pull candidate" : "Candidate test"}
          </button>
        );
      })}
    </div>
  );
}

function PullInputs({ pullsObj }: { pullsObj: UsePullsReturn }): React.JSX.Element {
  const { mode, repo, setRepo, file, setFile, profile, setProfile } = pullsObj;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
      <label style={{ gridColumn: "span 5 / span 5", fontSize: 14 }}>
        <span
          style={{
            marginBottom: 4,
            display: "block",
            fontSize: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          Repo
        </span>
        <Input
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
          }}
          placeholder="unsloth/gemma-4-E4B-it-GGUF"
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </label>
      <label style={{ gridColumn: "span 5 / span 5", fontSize: 14 }}>
        <span
          style={{
            marginBottom: 4,
            display: "block",
            fontSize: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          {mode === "file" ? "File" : "File (optional override)"}
        </span>
        <Input
          value={file}
          onChange={(e) => {
            setFile(e.target.value);
          }}
          placeholder={mode === "file" ? "gemma-4-E4B-it-Q8_0.gguf" : "(auto-pick via profile)"}
          style={{ width: "100%", fontFamily: "monospace" }}
        />
      </label>
      {(mode === "candidate" || mode === "test") && (
        <label style={{ gridColumn: "span 2 / span 2", fontSize: 14 }}>
          <span
            style={{
              marginBottom: 4,
              display: "block",
              fontSize: 12,
              color: "var(--color-text-secondary)",
            }}
          >
            Profile
          </span>
          <select
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as Profile | "");
            }}
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
            <option value="">(current)</option>
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <div
        style={{
          gridColumn: mode === "file" ? "span 2 / span 2" : "span 12 / span 12",
          display: "flex",
          alignItems: "flex-end",
          justifyContent: mode === "file" ? "flex-start" : "flex-end",
        }}
      >
        <Button type="submit" variant="primary">
          {mode === "test" ? "Enqueue test" : "Enqueue pull"}
        </Button>
      </div>
    </div>
  );
}

function PullQueue({ pullsObj }: { pullsObj: UsePullsReturn }): React.JSX.Element {
  const { cards, onDismiss, onDone } = pullsObj;
  if (cards.length === 0) {
    return <EditorialHero title="No pulls yet" lede="Fill out the form above and hit Enqueue." />;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {cards.map((spec) => (
        <PullCard
          key={spec.id}
          spec={spec}
          onDismiss={() => {
            onDismiss(spec.id);
          }}
          onDone={() => {
            onDone();
          }}
        />
      ))}
    </div>
  );
}

function PullsError({ error }: { error: string }): React.JSX.Element {
  return (
    <div
      style={{
        marginBottom: 12,
        borderRadius: 6,
        border: "1px solid var(--color-err)",
        backgroundColor: "var(--color-surface-1)",
        padding: "8px 12px",
        fontSize: 14,
        color: "var(--color-err)",
      }}
    >
      {error}
    </div>
  );
}
