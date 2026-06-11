import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, Input, StatusDot } from "@/ui";

interface Schedule {
  id: string;
  node: string;
  rel: string;
  intervalSeconds: number;
  lastRunAt: string | null;
  lastError: string | null;
  enabled: boolean;
}

function ScheduleRow(props: {
  s: Schedule;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { s, onToggle, onRemove } = props;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-2)",
        padding: "8px 12px",
        fontSize: 12,
      }}
    >
      <div>
        <span style={{ fontFamily: "monospace", color: "var(--color-text)" }}>{s.id}</span>
        <span style={{ margin: "0 4px", color: "var(--color-text-secondary)" }}>·</span>
        <span style={{ color: "var(--color-text-secondary)" }}>{s.node}</span>
        <span style={{ margin: "0 4px", color: "var(--color-text-secondary)" }}>·</span>
        <span style={{ fontFamily: "monospace", fontSize: 11 }}>{s.rel}</span>
        <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
          every {Math.round(s.intervalSeconds / 3600)} hours · last {s.lastRunAt ?? "—"}
          {s.lastError && (
            <span style={{ marginLeft: 8, color: "var(--color-err)" }}>err: {s.lastError}</span>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onToggle(s.id, !s.enabled);
          }}
          style={{ fontSize: 10, padding: "2px 8px" }}
        >
          {s.enabled ? "pause" : "resume"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            onRemove(s.id);
          }}
          style={{ fontSize: 10, padding: "2px 8px" }}
        >
          remove
        </Button>
      </div>
    </div>
  );
}

function SchedulerHeader(props: {
  running: boolean;
  lastTick: string;
  kickBusy: boolean;
  onKick: () => void;
  onStartStop: () => void;
}): React.JSX.Element {
  const { running, lastTick, kickBusy, onKick, onStartStop } = props;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: "var(--color-text)" }}>
        Bench scheduler
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <StatusDot tone={running ? "ok" : "idle"} />
        <span style={{ color: "var(--color-text-secondary)" }}>
          {running ? `running · last ${lastTick}` : "stopped"}
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={onKick}
          disabled={kickBusy}
          style={{ fontSize: 10, padding: "2px 8px" }}
        >
          {kickBusy ? "…" : "Kick"}
        </Button>
        <Button
          variant={running ? "secondary" : "primary"}
          size="sm"
          onClick={onStartStop}
          style={{ fontSize: 10, padding: "2px 8px" }}
        >
          {running ? "Stop" : "Start"}
        </Button>
      </div>
    </div>
  );
}

function AddScheduleForm(props: {
  id: string;
  setId: (v: string) => void;
  node: string;
  setNode: (v: string) => void;
  rel: string;
  setRel: (v: string) => void;
  hours: number;
  setHours: (v: number) => void;
  nodeNames: string[];
  busy: boolean;
  onAdd: () => void;
}): React.JSX.Element {
  const { id, setId, node, setNode, rel, setRel, hours, setHours, nodeNames, busy, onAdd } = props;
  return (
    <div
      style={{
        marginTop: 12,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "flex-end",
        gap: 8,
        fontSize: 12,
      }}
    >
      <Input
        type="text"
        placeholder="id (e.g. gemma-daily)"
        value={id}
        onChange={(e) => {
          setId(e.target.value);
        }}
        style={{ width: 160 }}
      />
      <select
        value={node}
        onChange={(e) => {
          setNode(e.target.value);
        }}
        style={{
          width: 128,
          borderRadius: 4,
          border: "1px solid var(--color-border)",
          backgroundColor: "var(--color-surface-2)",
          padding: "4px 8px",
          color: "var(--color-text)",
        }}
      >
        {nodeNames.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <Input
        type="text"
        placeholder="rel path"
        value={rel}
        onChange={(e) => {
          setRel(e.target.value);
        }}
        style={{ flex: 1, fontFamily: "monospace" }}
      />
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          color: "var(--color-text-secondary)",
        }}
      >
        every
        <Input
          type="number"
          min={1}
          max={168}
          value={hours}
          onChange={(e) => {
            setHours(Math.max(1, Number(e.target.value) || 1));
          }}
          style={{ width: 56, textAlign: "right" }}
        />
        hours
      </label>
      <Button
        variant="primary"
        size="sm"
        onClick={onAdd}
        disabled={busy || !id.trim() || !rel.trim()}
      >
        {busy ? "Adding…" : "Add schedule"}
      </Button>
    </div>
  );
}

function ScheduleList(props: {
  schedules: Schedule[];
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
}): React.JSX.Element {
  const { schedules, onToggle, onRemove } = props;
  return (
    <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 4 }}>
      {schedules.length === 0 && (
        <div style={{ fontSize: 12, color: "var(--color-text-secondary)" }}>No schedules yet.</div>
      )}
      {schedules.map((s) => (
        <ScheduleRow key={s.id} s={s} onToggle={onToggle} onRemove={onRemove} />
      ))}
    </div>
  );
}

export function SchedulerPanel(): React.JSX.Element {
  const utils = trpc.useUtils();
  const list = trpc.benchScheduleList.useQuery();
  const status = trpc.benchSchedulerStatus.useQuery(undefined, { refetchInterval: 5000 });
  const nodes = trpc.nodeList.useQuery();
  const add = trpc.benchScheduleAdd.useMutation({
    onSuccess: () => {
      void utils.benchScheduleList.invalidate();
    },
  });
  const remove = trpc.benchScheduleRemove.useMutation({
    onSuccess: () => {
      void utils.benchScheduleList.invalidate();
    },
  });
  const toggle = trpc.benchScheduleToggle.useMutation({
    onSuccess: () => {
      void utils.benchScheduleList.invalidate();
    },
  });
  const start = trpc.benchSchedulerStart.useMutation({
    onSuccess: () => {
      void utils.benchSchedulerStatus.invalidate();
    },
  });
  const stop = trpc.benchSchedulerStop.useMutation({
    onSuccess: () => {
      void utils.benchSchedulerStatus.invalidate();
    },
  });
  const kick = trpc.benchSchedulerKick.useMutation({
    onSuccess: () => {
      void utils.benchScheduleList.invalidate();
      void utils.benchSchedulerStatus.invalidate();
    },
  });

  const [id, setId] = useState("");
  const [node, setNode] = useState("local");
  const [rel, setRel] = useState("");
  const [hours, setHours] = useState(24);
  const [error, setError] = useState<string | null>(null);

  const schedules = (list.data ?? []) as Schedule[];
  const running = status.data?.running ?? false;
  const lastTick = status.data?.lastTickAt
    ? new Date(status.data.lastTickAt).toLocaleTimeString()
    : "—";

  function onAdd(): void {
    setError(null);
    if (!id.trim() || !rel.trim()) {
      setError("id and rel are required");
      return;
    }
    add.mutate(
      {
        id: id.trim(),
        node: node.trim() || "local",
        rel: rel.trim(),
        intervalSeconds: hours * 3600,
      },
      {
        onSuccess: () => {
          setId("");
          setRel("");
        },
        onError: (e) => {
          setError(e.message);
        },
      },
    );
  }

  return (
    <section
      style={{
        marginBottom: 24,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <SchedulerHeader
        running={running}
        lastTick={lastTick}
        kickBusy={kick.isPending}
        onKick={() => {
          kick.mutate();
        }}
        onStartStop={() => {
          if (running) stop.mutate();
          else start.mutate({ tickIntervalSeconds: 60 });
        }}
      />
      <AddScheduleForm
        id={id}
        setId={setId}
        node={node}
        setNode={setNode}
        rel={rel}
        setRel={setRel}
        hours={hours}
        setHours={setHours}
        nodeNames={(nodes.data?.nodes ?? [{ name: "local" }]).map((n) => n.name)}
        busy={add.isPending}
        onAdd={onAdd}
      />
      {error && (
        <div style={{ marginTop: 8, fontSize: 12, color: "var(--color-err)" }}>{error}</div>
      )}
      <ScheduleList
        schedules={schedules}
        onToggle={(scheduleId, enabled) => {
          toggle.mutate({ id: scheduleId, enabled });
        }}
        onRemove={(scheduleId) => {
          remove.mutate({ id: scheduleId });
        }}
      />
    </section>
  );
}
