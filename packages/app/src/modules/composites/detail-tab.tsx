import * as React from "react";
import { useState } from "react";
import * as YAML from "yaml";

import { trpc } from "@/lib/trpc";
import { Button, StatusDot } from "@/ui";

import type { ApplyEvent, CompositeShape } from "./types";

import { ComponentTree, DestroySection } from "./components";
import { formatTimestamp } from "./helpers";

function LiveStatusStream(props: { name: string }): React.JSX.Element {
  const { name } = props;
  const [events, setEvents] = useState<ApplyEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  React.useEffect(() => {
    queueMicrotask(() => {
      setEvents([]);
      setError(null);
    });
  }, [name]);
  trpc.compositeStatus.useSubscription(
    { name },
    {
      enabled: !!name,
      onData: (ev) => {
        setEvents((prev) => [...prev, ev as ApplyEvent]);
      },
      onError: (err) => {
        setError(err.message);
      },
    },
  );
  if (error)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-err)",
          background: "var(--color-surface-1)",
          padding: "8px 12px",
          color: "var(--color-err)",
          fontSize: 12,
        }}
      >
        Live status unavailable: {error}
      </div>
    );
  if (events.length === 0)
    return (
      <div
        style={{
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          background: "var(--color-surface-1)",
          padding: "8px 12px",
          color: "var(--color-text-secondary)",
          fontSize: 12,
        }}
      >
        Waiting for status events...
      </div>
    );
  return (
    <ul
      style={{
        maxHeight: 192,
        marginTop: 2,
        overflow: "auto",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 8,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
      }}
    >
      {events.map((ev, i) => (
        <li key={i} style={{ color: "var(--color-text-secondary)" }}>
          <span style={{ color: "var(--color-text)" }}>{ev.type}</span>
          {"phase" in ev && ` - ${ev.phase}`}
          {"ref" in ev && ` - ${ev.ref.kind}/${ev.ref.name}`}
          {"message" in ev && ev.message && ` - ${ev.message}`}
          {"ok" in ev && ` - ok=${String(ev.ok)}`}
        </li>
      ))}
    </ul>
  );
}

function DetailNotice(props: {
  dashed?: boolean;
  error?: boolean;
  noBg?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: `1px ${props.dashed ? "dashed" : "solid"} var(--color-border)`,
        ...(props.error ? { borderColor: "var(--color-err)" } : {}),
        ...(props.noBg ? {} : { background: "var(--color-surface-1)" }),
        padding: props.error ? "8px 12px" : 16,
        color: props.error ? "var(--color-err)" : "var(--color-text-secondary)",
        fontSize: 14,
      }}
    >
      {props.children}
    </div>
  );
}

function DetailHeader({ manifest }: { manifest: CompositeShape }): React.JSX.Element {
  const phase = manifest.status?.phase;
  const tone =
    phase === "Ready" || phase === "Pending" || phase === "Applying"
      ? "ok"
      : phase === "Failed"
        ? "err"
        : phase === "Degraded"
          ? "warn"
          : "idle";
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
        <h2 style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: "var(--color-text)" }}>
          {manifest.metadata.name}
        </h2>
        <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10 }}>
          <StatusDot tone={tone} />
          {phase ?? "Unapplied"}
        </span>
        <span style={{ color: "var(--color-text-secondary)", fontSize: 12 }}>
          last applied {formatTimestamp(manifest.status?.appliedAt)}
        </span>
      </div>
      {manifest.metadata.labels && (
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 4 }}>
          {Object.entries(manifest.metadata.labels).map(([k, v]) => (
            <span
              key={k}
              style={{
                borderRadius: "var(--r-md)",
                border: "1px solid var(--color-border)",
                background: "var(--color-surface-2)",
                padding: "2px 6px",
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                color: "var(--color-text-secondary)",
              }}
            >
              {k}={v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function DetailTab(props: {
  name: string | null;
  onSelectNone: () => void;
  onPickFromList: (name: string) => void;
}): React.JSX.Element {
  const { name, onSelectNone, onPickFromList } = props;
  const query = trpc.compositeGet.useQuery({ name: name ?? "" }, { enabled: !!name });
  const [showYaml, setShowYaml] = useState(false);

  if (!name)
    return (
      <DetailNotice dashed>
        No composite selected. Pick one from the{" "}
        <Button
          variant="secondary"
          size="sm"
          type="button"
          onClick={() => {
            onPickFromList("");
          }}
        >
          List tab
        </Button>
        .
      </DetailNotice>
    );
  if (query.isLoading)
    return (
      <DetailNotice>
        Loading <span style={{ fontFamily: "var(--font-mono)" }}>{name}</span>...
      </DetailNotice>
    );
  if (query.error)
    return (
      <DetailNotice error>
        Failed to load composite {name}: {query.error.message}
      </DetailNotice>
    );

  const manifest = query.data as CompositeShape | null;
  if (!manifest)
    return (
      <DetailNotice dashed noBg>
        Composite {name} not found.
      </DetailNotice>
    );

  const serializable = {
    apiVersion: manifest.apiVersion,
    kind: manifest.kind,
    metadata: manifest.metadata,
    spec: manifest.spec,
    ...(manifest.status ? { status: manifest.status } : {}),
  };

  return (
    <div style={{ marginTop: 16 }}>
      <DetailHeader manifest={manifest} />
      <ComponentTree spec={manifest.spec} statusComponents={manifest.status?.components ?? []} />
      <div>
        <div style={{ marginBottom: 4, fontWeight: 500, color: "var(--color-text)", fontSize: 12 }}>
          Live status
        </div>
        <LiveStatusStream name={manifest.metadata.name} />
      </div>
      <div>
        <Button
          type="button"
          onClick={() => {
            setShowYaml(!showYaml);
          }}
          style={{ fontSize: 10 }}
        >
          {showYaml ? "Hide YAML" : "View YAML"}
        </Button>
        {showYaml && (
          <pre
            style={{
              marginTop: 8,
              overflowX: "auto",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface-2)",
              padding: 8,
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--color-text)",
            }}
          >
            {YAML.stringify(serializable)}
          </pre>
        )}
      </div>
      <DestroySection name={manifest.metadata.name} onDestroyed={onSelectNone} />
    </div>
  );
}
