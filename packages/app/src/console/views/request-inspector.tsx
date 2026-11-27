import type { CapturedRequest, RequestSummary } from "@llamactl/remote";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { DashboardSettings } from "./dashboard-settings";

import { useBrowserRequests } from "../browser-requests";
import { consoleSessionStore } from "../session-store";
import { dashboardPolling } from "./dashboard-settings";
import "./request-inspector.css";

interface Listing {
  enabled: boolean;
  requests: RequestSummary[];
}

async function fetchCapture<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, cache: "no-store" });
  if (response.status === 401) consoleSessionStore.markInvalid();
  if (!response.ok) throw new Error("Request capture unavailable");
  return (await response.json()) as T;
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

function RequestRow({
  request,
  expanded,
  onClick,
}: {
  request: RequestSummary;
  expanded: boolean;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button type="button" className="inspector-row" onClick={onClick} aria-expanded={expanded}>
      <time dateTime={new Date(request.at).toISOString()}>{when.format(request.at)}</time>
      <strong>{request.model ?? "Unknown model"}</strong>
      <span>{request.path}</span>
      <span>
        {request.status || "—"} · {(request.durationMs / 1000).toFixed(2)} s
      </span>
    </button>
  );
}

function Payload({
  heading,
  value,
  absent,
}: {
  heading: string;
  value: unknown;
  absent: string;
}): React.JSX.Element {
  return (
    <div>
      <h4>{heading}</h4>
      {value === null ? <p>{absent}</p> : <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>}
    </div>
  );
}

function ResponsePayload({ value }: { value: unknown }): React.JSX.Element {
  const body =
    typeof value === "object" && value !== null
      ? (value as { reply?: unknown; reasoning?: unknown })
      : null;
  const reply = typeof body?.reply === "string" ? body.reply : "";
  const reasoning = typeof body?.reasoning === "string" ? body.reasoning : "";
  if (!reply && !reasoning) {
    return <Payload heading="Response" value={value} absent="Response payload unavailable." />;
  }
  return (
    <div>
      <h4>Response</h4>
      {reply ? <pre tabIndex={0}>{reply}</pre> : null}
      {reasoning ? (
        <details>
          <summary>Model reasoning</summary>
          <pre tabIndex={0}>{reasoning}</pre>
        </details>
      ) : null}
      <details>
        <summary>Response fields</summary>
        <pre tabIndex={0}>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

function RequestDetail({ request }: { request: CapturedRequest }): React.JSX.Element {
  return (
    <section className="inspector-detail" aria-label="Request details">
      <h4>Details</h4>
      <dl className="fleet-metrics">
        <div>
          <dt>Request ID</dt>
          <dd>{request.id}</dd>
        </div>
        <div>
          <dt>Endpoint</dt>
          <dd>POST {request.path}</dd>
        </div>
        <div>
          <dt>HTTP status</dt>
          <dd>{request.status || "—"}</dd>
        </div>
        <div>
          <dt>First response data</dt>
          <dd>{request.firstByteMs === null ? "—" : `${String(request.firstByteMs)} ms`}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{request.durationMs} ms</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>
            {request.cancelled
              ? "Cancelled"
              : request.status >= 400 || !request.status
                ? "Failed"
                : "Finished"}
          </dd>
        </div>
      </dl>
      {request.truncated ? (
        <p role="status">Capture size limit reached. Some content may be omitted.</p>
      ) : null}
      <Payload heading="Request" value={request.request} absent="Request payload unavailable." />
      <ResponsePayload value={request.response} />
    </section>
  );
}

function FleetDetail({ base, id }: { base: string; id: string }): React.JSX.Element {
  const detail = useQuery({
    queryKey: ["captured-request", base, id],
    queryFn: ({ signal }) => fetchCapture<CapturedRequest>(`${base}/${id}`, signal),
    retry: false,
    gcTime: 0,
  });
  if (detail.isError) return <p role="status">Request detail is unavailable or has expired.</p>;
  if (detail.isPending) return <p role="status">Loading request detail…</p>;
  return <RequestDetail request={detail.data} />;
}

export function FleetRequestInspector({
  node,
  settings,
}: {
  node: string;
  settings: DashboardSettings;
}): React.JSX.Element | null {
  const base = `/api/n/${encodeURIComponent(node)}/requests`;
  const [selected, setSelected] = useState<string | null>(null);
  const listing = useQuery({
    queryKey: ["captured-requests", base],
    queryFn: ({ signal }) => fetchCapture<Listing>(base, signal),
    ...dashboardPolling(settings, 15),
    retry: false,
  });
  if (!listing.data?.enabled)
    return listing.isError ? (
      <p className="fleet-muted">Fleet request capture unavailable.</p>
    ) : null;
  return (
    <section className="request-inspector" aria-label={`Captured requests on ${node}`}>
      <h3>Captured requests</h3>
      {listing.data.requests.length === 0 ? (
        <p className="fleet-muted">No retained requests.</p>
      ) : null}
      {listing.data.requests.slice(0, settings.limit).map((request) => (
        <div key={request.id}>
          <RequestRow
            request={request}
            expanded={selected === request.id}
            onClick={() => {
              setSelected((current) => (current === request.id ? null : request.id));
            }}
          />
          {selected === request.id ? <FleetDetail base={base} id={request.id} /> : null}
        </div>
      ))}
    </section>
  );
}

export function BrowserRequestInspector({
  settings,
}: {
  settings: DashboardSettings;
}): React.JSX.Element | null {
  const requests = useBrowserRequests();
  const [selected, setSelected] = useState<string | null>(null);
  const visible = requests
    .filter(({ node }) => !settings.node || node === settings.node)
    .slice(0, settings.limit);
  if (visible.length === 0) return null;
  return (
    <section className="fleet-panel request-inspector">
      <h2>Web Chat requests</h2>
      {visible.map((request) => (
        <div key={request.id}>
          <RequestRow
            request={{ ...request, path: request.node }}
            expanded={selected === request.id}
            onClick={() => {
              setSelected((current) => (current === request.id ? null : request.id));
            }}
          />
          {selected === request.id ? <RequestDetail request={request} /> : null}
        </div>
      ))}
    </section>
  );
}
