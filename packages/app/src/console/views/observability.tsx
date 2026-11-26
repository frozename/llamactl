import type { AppRouter, PenumbraHandoffs } from "@llamactl/remote";
import type { inferRouterOutputs } from "@trpc/server";

import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import type { DashboardSettings } from "./dashboard-settings";

import { dispatchableNodes } from "../node-scope";
import { NodeScopedProvider } from "../node-scoped-provider";
import { useNodeTrpc } from "../node-trpc";
import { consoleHref } from "../router";
import { dashboardPolling, refreshPeriods, requestLimits } from "./dashboard-settings";
import { RequestChart, SlotActivity } from "./dashboard-visuals";
import "./observability.css";

type Outputs = inferRouterOutputs<AppRouter>;
type Observation = Outputs["inferenceObservations"]["workloads"][number];
type Snapshot = NonNullable<Outputs["fleetSnapshot"]>;
type Workload = Outputs["workloadList"][number];

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

function measure(value: number | null | undefined, suffix = ""): string {
  return value === null || value === undefined ? "—" : `${numberFormat.format(value)}${suffix}`;
}

function when(at: string): string {
  const time = Date.parse(at);
  return Number.isFinite(time) ? dateFormat.format(time) : "—";
}

function median(values: readonly (number | null)[]): number | null {
  const sorted = values
    .filter((value): value is number => value !== null && Number.isFinite(value))
    .sort((a, b) => a - b);
  const high = sorted[Math.floor(sorted.length / 2)];
  const low = sorted[Math.floor((sorted.length - 1) / 2)];
  return high === undefined || low === undefined ? null : (high + low) / 2;
}

function Metrics({ values }: { values: [string, string][] }): React.JSX.Element {
  return (
    <dl className="fleet-metrics">
      {values.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function queueMetric(observation: Observation | undefined): [string, string] {
  return observation?.waiting === undefined
    ? ["Queued now", measure(observation?.queued)]
    : ["Waiting requests", measure(observation.waiting)];
}

function engineMemoryMetrics(observation: Observation | undefined): [string, string][] {
  if (observation?.source !== "kapitsa-control") return [];
  const gib = (bytes: number | null | undefined): string =>
    measure(typeof bytes === "number" ? bytes / 1024 ** 3 : bytes, " GiB");
  return [
    ["Engine GPU memory", gib(observation.allocatedBytes)],
    ["Engine KV memory", gib(observation.kvBytes)],
  ];
}

function ExternalModels({
  inventory,
}: {
  inventory: Outputs["inferenceObservations"]["externalModels"];
}): React.JSX.Element | null {
  if (inventory === undefined || inventory.state === "unconfigured") return null;
  if (inventory.state === "invalid-config") {
    return <p className="fleet-muted">External model inventory could not be read.</p>;
  }
  if (inventory.models.length === 0) return null;
  return (
    <div className="fleet-workload">
      <h3>External models</h3>
      {inventory.models.map((row) => (
        <div key={`${String(row.port)}/${row.model}`} className="fleet-row">
          <span>
            {row.model} · port {row.port}
          </span>
          <span>{row.state}</span>
        </div>
      ))}
    </div>
  );
}

function firstTokenMetric(
  observation: Observation | undefined,
  runs: NonNullable<Observation["runs"]>,
): [string, string] {
  return observation?.source === "kapitsa-control"
    ? [
        "Engine first token estimate",
        measure(median(runs.map((run) => run.engineFirstMs ?? null)), " ms"),
      ]
    : ["TTFT median", measure(median(runs.map((run) => run.ttftMs)), " ms")];
}

function WorkloadChart({
  observation,
  settings,
}: {
  observation: Observation | undefined;
  settings: DashboardSettings;
}): React.JSX.Element | null {
  const runs = observation?.runs?.slice(0, settings.limit) ?? [];
  if (settings.chart === "latency") {
    return (
      <RequestChart
        title={
          observation?.source === "kapitsa-control"
            ? "Engine first token estimate"
            : "Time to first token"
        }
        unit="ms"
        newestFirst={runs.map((run) => run.engineFirstMs ?? run.ttftMs)}
      />
    );
  }
  return (
    <RequestChart
      title={settings.chart === "decode" ? "Decode per request" : "Prefill per request"}
      unit="tok/s"
      newestFirst={runs.map((run) =>
        settings.chart === "decode" ? run.decodeTps : run.prefillTps,
      )}
    />
  );
}

function Phase({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="dashboard-phase" data-phase={label}>
      {label}
    </span>
  );
}

function WorkloadStats({
  name,
  node,
  observation,
  snapshot,
  workload,
  settings,
}: {
  name: string;
  node: string;
  observation: Observation | undefined;
  snapshot: Snapshot | undefined;
  workload: Workload | undefined;
  settings: DashboardSettings;
}): React.JSX.Element {
  const sample = snapshot?.workloads.find((row) => row.name === name);
  if (workload?.phase === "Stopped" && observation === undefined && !sample?.reachable) {
    return (
      <div className="fleet-workload fleet-row">
        <a href={consoleHref({ view: "workloads", workload: name, node })}>{name}</a>
        <Phase label="Stopped" />
      </div>
    );
  }

  const stats =
    snapshot?.kind === "fleet-snapshot"
      ? snapshot.engineThroughput?.find((row) => row.workload === name)?.stats
      : null;
  const runs =
    observation?.runs?.slice(0, settings.limit).filter((run) => run.state === "completed") ?? [];
  const supervisorCachedShare = stats?.requestCachedPromptShare ?? null;
  const slots = observation?.slots;
  const active = slots?.every((slot) => slot.processing !== null)
    ? slots.filter((slot) => slot.processing === true).length
    : null;
  const capacity = observation?.capacity?.slots ?? slots?.length;
  const probeRtt = sample && "health_rtt_ms" in sample ? sample.health_rtt_ms : null;
  const cachedShare = median(
    runs.map((run) =>
      run.promptN && run.cachedN !== null ? (run.cachedN / run.promptN) * 100 : null,
    ),
  );
  return (
    <div className="fleet-workload">
      <div className="fleet-row">
        <a href={consoleHref({ view: "workloads", workload: name, node })}>{name}</a>
        <Phase
          label={
            workload?.phase ??
            (sample?.reachable ? "Reachable" : observation ? "Process present" : "Unavailable")
          }
        />
      </div>
      <div className="dashboard-insights">
        <WorkloadChart observation={observation} settings={settings} />
        <Metrics
          values={[
            ["Active / slots", `${measure(active)} / ${measure(capacity)}`],
            ["Context / slot", measure(observation?.capacity?.context)],
            queueMetric(observation),
            ...engineMemoryMetrics(observation),
            ["Health RTT", measure(probeRtt, " ms")],
            [
              "RSS",
              measure(
                sample && "rss_mb" in sample && sample.rss_mb !== null
                  ? sample.rss_mb / 1024
                  : null,
                " GiB",
              ),
            ],
            [
              "Decode median",
              measure(
                median(runs.map((run) => run.decodeTps)) ?? stats?.requestDecodeTokPerSec?.median,
                " tok/s",
              ),
            ],
            [
              "Prefill median",
              measure(
                median(runs.map((run) => run.prefillTps)) ?? stats?.requestPrefillTokPerSec?.median,
                " tok/s",
              ),
            ],
            firstTokenMetric(observation, runs),
            [
              "Prompt cached",
              measure(
                cachedShare ??
                  (supervisorCachedShare === null ? null : supervisorCachedShare * 100),
                "%",
              ),
            ],
          ]}
        />
      </div>
      <SlotActivity slots={slots} capacity={observation?.capacity} />
    </div>
  );
}

function NodeMemory({
  live,
  snapshot,
}: {
  live: Outputs["inferenceObservations"]["nodeMemory"] | undefined;
  snapshot: Snapshot | undefined;
}): React.JSX.Element {
  const memory = live ?? (snapshot?.kind === "fleet-snapshot" ? snapshot.node_mem : undefined);
  const mem = memory?.available === false ? null : memory;
  const gib = (mb: number | undefined): string =>
    measure(mb === undefined ? null : mb / 1024, " GiB");
  return (
    <Metrics
      values={[
        ["Free memory", gib(mem?.free_mb)],
        ["Active memory", gib(mem?.active_mb)],
        ["Wired memory", gib(mem?.wired_mb)],
        ["Compressed memory", gib(mem?.compressor_mb)],
        ["Swap-out pages", measure(mem?.swap_out)],
      ]}
    />
  );
}

function NodeWorkloadStats({
  node,
  sample,
  observations,
  workloadRows,
  settings,
}: {
  node: string;
  sample: Snapshot | undefined;
  observations: Outputs["inferenceObservations"] | undefined;
  workloadRows: Workload[];
  settings: DashboardSettings;
}): React.JSX.Element {
  const names = new Set([
    ...(sample?.workloads.map((row) => row.name) ?? []),
    ...(observations?.workloads.map((row) => row.workload) ?? []),
  ]);
  const stopped = workloadRows.filter((row) => row.phase === "Stopped" && !names.has(row.name));
  for (const row of workloadRows) {
    if (row.phase !== "Stopped") names.add(row.name);
  }
  return (
    <>
      {names.size === 0 && stopped.length === 0 ? (
        <p className="fleet-muted">No workloads in this sample.</p>
      ) : null}
      {[...names].map((name) => (
        <WorkloadStats
          key={name}
          name={name}
          node={node}
          observation={observations?.workloads.find((row) => row.workload === name)}
          snapshot={sample}
          workload={workloadRows.find((row) => row.name === name)}
          settings={settings}
        />
      ))}
      {stopped.length > 0 ? (
        <details className="dashboard-inactive">
          <summary>{stopped.length} stopped workloads</summary>
          {stopped.map((row) => (
            <div className="fleet-workload" key={row.name}>
              <a href={consoleHref({ view: "workloads", workload: row.name, node })}>{row.name}</a>
            </div>
          ))}
        </details>
      ) : null}
    </>
  );
}

function NodeStats({
  node,
  workloadRows,
  settings,
}: {
  node: string;
  workloadRows: Workload[];
  settings: DashboardSettings;
}): React.JSX.Element {
  const trpc = useNodeTrpc();
  const snapshot = trpc.fleetSnapshot.useQuery(
    { include: ["local-routes"] },
    dashboardPolling(settings, 15),
  );
  const live = trpc.inferenceObservations.useQuery(undefined, dashboardPolling(settings));
  const data = snapshot.isError ? null : snapshot.data;
  const stale =
    data?.kind === "fleet-snapshot" && snapshot.dataUpdatedAt - Date.parse(data.ts) > 90_000;
  const sample = stale ? undefined : (data ?? undefined);
  const observations = live.isError ? undefined : live.data;
  return (
    <section className="fleet-panel">
      <div className="fleet-row">
        <h2>{node}</h2>
        <Phase
          label={
            snapshot.isError
              ? "Telemetry unavailable"
              : snapshot.isPending
                ? "Connecting…"
                : "Reachable"
          }
        />
      </div>
      <p className="fleet-muted">
        {data?.kind === "fleet-snapshot"
          ? `Supervisor sample ${when(data.ts)}${stale ? " · stale" : ""}`
          : "No supervisor sample"}
        {observations ? ` · Engine sample ${when(observations.sampledAt)}` : ""}
      </p>
      <NodeMemory live={observations?.nodeMemory} snapshot={sample} />
      <ExternalModels inventory={observations?.externalModels} />
      <NodeWorkloadStats
        node={node}
        sample={sample}
        observations={observations}
        workloadRows={workloadRows}
        settings={settings}
      />
    </section>
  );
}

function WorkloadRuns({
  node,
  workload,
  settings,
}: {
  node: string;
  workload: Observation;
  settings: DashboardSettings;
}): React.JSX.Element {
  const runs = workload.runs?.slice(0, settings.limit) ?? [];
  return (
    <div className="fleet-workload">
      <a href={consoleHref({ view: "workloads", workload: workload.workload, node })}>
        {workload.workload}
      </a>
      <SlotActivity slots={workload.slots} capacity={workload.capacity} />
      {workload.slots === null ? <p className="fleet-muted">Slot activity unavailable.</p> : null}
      <WorkloadChart observation={workload} settings={settings} />
      {runs.length > 0 ? (
        <div className="fleet-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Request / time</th>
                <th>Status</th>
                <th>Prefill tok/s</th>
                <th>Decode tok/s</th>
                <th>
                  {workload.source === "kapitsa-control"
                    ? "Engine first token estimate ms"
                    : "TTFT ms"}
                </th>
                <th>Queue ms</th>
                <th>Total ms</th>
                <th>Generated</th>
                <th>Cached / prompt</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr key={`${run.id ?? ""}/${String(i)}`}>
                  <td>{[run.id, run.at].filter(Boolean).join(" · ") || "—"}</td>
                  <td>{run.state}</td>
                  <td>{measure(run.prefillTps)}</td>
                  <td>{measure(run.decodeTps)}</td>
                  <td>{measure(run.engineFirstMs ?? run.ttftMs)}</td>
                  <td>{measure(run.queueMs)}</td>
                  <td>{measure(run.durationMs)}</td>
                  <td>{measure(run.generatedN)}</td>
                  <td>
                    {measure(run.cachedN)} / {measure(run.promptN)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="fleet-muted">
          {workload.runs === null
            ? "Request history unavailable."
            : "No request records in the log tail."}
        </p>
      )}
    </div>
  );
}

function NodeBenchmarks({ settings }: { settings: DashboardSettings }): React.JSX.Element {
  const trpc = useNodeTrpc();
  const history = trpc.benchHistory.useQuery({ limit: 15 }, dashboardPolling(settings, 15));
  const scheduler = trpc.benchSchedulerStatus.useQuery(undefined, dashboardPolling(settings, 15));
  const benchmarks = history.isError ? [] : [...(history.data ?? [])].reverse();
  return (
    <>
      <h3>Benchmarks {scheduler.data?.inflight && !scheduler.isError ? "· running" : ""}</h3>
      {history.isError ? (
        <p className="fleet-muted">Benchmark history unavailable.</p>
      ) : history.isPending ? (
        <p className="fleet-muted">Loading benchmarks…</p>
      ) : benchmarks.length === 0 ? (
        <p className="fleet-muted">No benchmark results recorded.</p>
      ) : (
        <div className="fleet-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Date</th>
                <th>Prefill tok/s</th>
                <th>Decode tok/s</th>
              </tr>
            </thead>
            <tbody>
              {benchmarks.map((row, i) => (
                <tr key={`${row.rel}/${row.updated_at}/${String(i)}`}>
                  <td>{row.rel}</td>
                  <td>{when(row.updated_at)}</td>
                  <td>{row.prompt_ts || "—"}</td>
                  <td>{row.gen_ts || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NodeRuns({
  node,
  settings,
}: {
  node: string;
  settings: DashboardSettings;
}): React.JSX.Element {
  const trpc = useNodeTrpc();
  const live = trpc.inferenceObservations.useQuery(undefined, dashboardPolling(settings));
  const workloads = live.isError ? [] : (live.data?.workloads ?? []);
  return (
    <section className="fleet-panel">
      <div className="fleet-row">
        <h2>{node}</h2>
        <span>{live.data && !live.isError ? when(live.data.sampledAt) : ""}</span>
      </div>
      <h3>Inference</h3>
      {live.isError ? (
        <p className="fleet-muted">Request observations unavailable on this node.</p>
      ) : live.isPending ? (
        <p className="fleet-muted">Loading inference runs…</p>
      ) : workloads.length === 0 ? (
        <p className="fleet-muted">No active engine processes.</p>
      ) : null}
      {workloads.map((workload) => (
        <WorkloadRuns key={workload.workload} node={node} workload={workload} settings={settings} />
      ))}
      <NodeBenchmarks settings={settings} />
    </section>
  );
}

function PenumbraRuns({ settings }: { settings: DashboardSettings }): React.JSX.Element | null {
  const handoffs = useQuery({
    queryKey: ["console-addon-penumbra"],
    queryFn: async ({ signal }) => {
      const response = await fetch("/api/addons/penumbra/handoffs", { signal });
      if (!response.ok) throw new Error("Penumbra add-on unavailable");
      return (await response.json()) as PenumbraHandoffs;
    },
    ...dashboardPolling(settings, 15),
  });
  if (handoffs.isPending || handoffs.data?.state === "unconfigured") return null;

  const rows = !handoffs.isError && handoffs.data.state === "ready" ? handoffs.data.handoffs : null;
  return (
    <section className="fleet-panel">
      <h2>Penumbra handoffs</h2>
      {rows === null ? (
        <p className="fleet-muted">Penumbra is unavailable.</p>
      ) : rows.length === 0 ? (
        <p className="fleet-muted">No handoffs in this sample.</p>
      ) : (
        <div className="fleet-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Handoff</th>
                <th>Seat</th>
                <th>Status</th>
                <th>Created</th>
                <th>Resolved</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.handoff_id}>
                  <td>{row.handoff_id}</td>
                  <td>{row.to_agent}</td>
                  <td>{row.status}</td>
                  <td>{when(row.ts)}</td>
                  <td>{row.resolved_at ? when(row.resolved_at) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DashboardToolbar({
  settings,
  nodes,
  onChange,
}: {
  settings: DashboardSettings;
  nodes: string[];
  onChange: (partial: Partial<DashboardSettings>) => void;
}): React.JSX.Element {
  return (
    <div className="dashboard-controls" aria-label="Dashboard controls">
      <label>
        <span>Node</span>
        <select
          className="console-select"
          value={settings.node}
          onChange={(event) => {
            onChange({ node: event.target.value });
          }}
        >
          <option value="">All nodes</option>
          {nodes.map((node) => (
            <option key={node} value={node}>
              {node}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Refresh</span>
        <select
          className="console-select"
          value={settings.seconds}
          onChange={(event) => {
            onChange({ seconds: Number(event.target.value) });
          }}
        >
          {refreshPeriods.map((seconds) => (
            <option key={seconds} value={seconds}>
              {seconds} s
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Recent requests</span>
        <select
          className="console-select"
          value={settings.limit}
          onChange={(event) => {
            onChange({ limit: Number(event.target.value) });
          }}
        >
          {requestLimits.map((limit) => (
            <option key={limit} value={limit}>
              {limit}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Chart metric</span>
        <select
          className="console-select"
          value={settings.chart}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "decode" || value === "prefill" || value === "latency")
              onChange({ chart: value });
          }}
        >
          <option value="decode">Decode</option>
          <option value="prefill">Prefill</option>
          <option value="latency">First token</option>
        </select>
      </label>
      <button
        type="button"
        className="console-control dashboard-pause"
        onClick={() => {
          onChange({ paused: !settings.paused });
        }}
      >
        {settings.paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}

export function ObservabilityView({ mode }: { mode: "stats" | "runs" }): React.JSX.Element {
  const [settings, setSettings] = React.useState<DashboardSettings>({
    paused: false,
    seconds: 5,
    limit: 25,
    chart: "decode",
    node: "",
  });
  const trpc = useNodeTrpc();
  const catalog = trpc.nodeList.useQuery();
  const workloads = trpc.workloadList.useQuery(undefined, {
    ...dashboardPolling(settings, 15),
    enabled: mode === "stats" && !settings.paused,
  });
  const nodes = catalog.data ? dispatchableNodes(catalog.data).map(({ name }) => name) : [];
  const visibleNodes = nodes.includes(settings.node)
    ? [settings.node]
    : [...nodes].sort((a, b) => Number(b === "local") - Number(a === "local"));
  return (
    <main className="console-page fleet-observability" data-testid={`console-view-${mode}`}>
      <header className="dashboard-heading">
        <div className="dashboard-hero">
          <div>
            <h1>{mode === "stats" ? "Fleet Stats" : "Runs"}</h1>
            <p className="console-caption">
              {mode === "stats"
                ? "Node memory, slot activity and model performance"
                : "Live inference, recent requests and recorded benchmarks"}
            </p>
          </div>
          <span className="dashboard-phase" data-phase={settings.paused ? "Paused" : "Live"}>
            {settings.paused ? "Paused" : "Live"}
          </span>
        </div>
        <DashboardToolbar
          settings={settings}
          nodes={nodes}
          onChange={(partial) => {
            setSettings((current) => ({ ...current, ...partial }));
          }}
        />
      </header>
      {catalog.isError ? <p role="alert">Fleet inventory unavailable.</p> : null}
      {catalog.isPending ? <p>Loading fleet inventory…</p> : null}
      {catalog.isSuccess && nodes.length === 0 ? <p>No agent nodes registered.</p> : null}
      {mode === "runs" ? <PenumbraRuns settings={settings} /> : null}
      <div className="dashboard-nodes">
        {visibleNodes.map((name) => (
          <NodeScopedProvider key={name} node={name}>
            {mode === "stats" ? (
              <NodeStats
                node={name}
                settings={settings}
                workloadRows={workloads.data?.filter((row) => row.node === name) ?? []}
              />
            ) : (
              <NodeRuns node={name} settings={settings} />
            )}
          </NodeScopedProvider>
        ))}
      </div>
    </main>
  );
}
