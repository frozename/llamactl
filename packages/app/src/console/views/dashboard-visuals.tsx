import type * as React from "react";

const numeral = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

interface Slot {
  id: number | null;
  processing: boolean | null;
  nPast: number | null;
  nDecoded: number | null;
  context?: number;
}

export function SlotActivity({
  slots,
  capacity,
}: {
  slots: Slot[] | null | undefined;
  capacity: { slots: number; context: number | null } | null | undefined;
}): React.JSX.Element | null {
  if (!slots?.length) return null;
  return (
    <div className="dashboard-slots" aria-label="Engine slots">
      {slots.map((slot, index) => {
        const state = slot.processing === null ? "Unknown" : slot.processing ? "Busy" : "Idle";
        const context = slot.context ?? capacity?.context;
        const fill =
          context && slot.nPast !== null ? Math.min(context, Math.max(0, slot.nPast)) : null;
        const caption =
          slot.nDecoded === null ? state : `${state} · ${numeral.format(slot.nDecoded)} generated`;
        return (
          <div
            className="dashboard-slot"
            key={`${String(slot.id)}/${String(index)}`}
            data-state={state}
          >
            <div className="fleet-row">
              <strong>Slot {slot.id ?? "—"}</strong>
              <span>{caption}</span>
            </div>
            {fill !== null && context !== null && context !== undefined ? (
              <meter
                aria-label="Context used"
                value={fill}
                max={context}
                title={`${numeral.format(fill)} / ${numeral.format(context)} tokens`}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function RequestChart({
  title,
  unit,
  newestFirst,
}: {
  title: string;
  unit: string;
  newestFirst: (number | null)[];
}): React.JSX.Element | null {
  const samples = newestFirst
    .map((value) => (value !== null && Number.isFinite(value) && value >= 0 ? value : null))
    .reverse();
  const reported = samples.filter((value): value is number => value !== null);
  if (samples.length === 0) return null;
  if (reported.length === 0) {
    return (
      <figure className="dashboard-chart">
        <figcaption>
          <strong>{title}</strong>
        </figcaption>
        <p className="fleet-muted">No recent samples reported this metric.</p>
      </figure>
    );
  }
  const peak = Math.max(...reported);
  const axisMax = Math.max(1, Math.ceil(peak / 10) * 10);
  const summary = `${String(reported.length)} of ${String(samples.length)} requests reported. Peak ${numeral.format(peak)} ${unit}.`;
  return (
    <figure className="dashboard-chart" aria-label={`${title}. ${summary}`}>
      <figcaption className="fleet-row">
        <strong>{title}</strong>
        <span>
          {reported.length} requests with data · {unit}
        </span>
      </figcaption>
      <div className="dashboard-chart-plot" role="img" aria-label={summary}>
        <div className="dashboard-chart-axis" aria-hidden="true">
          <span>{numeral.format(axisMax)}</span>
          <span>0</span>
        </div>
        <div className="dashboard-chart-bars" aria-hidden="true">
          {samples.map((sample, index) => (
            <div className="dashboard-chart-bin" key={index}>
              <div
                className="dashboard-chart-bar"
                data-missing={sample === null}
                style={{ height: `${String(sample === null ? 0 : (sample / axisMax) * 100)}%` }}
                title={sample === null ? "Unavailable" : `${numeral.format(sample)} ${unit}`}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="dashboard-chart-time" aria-hidden="true">
        <span>Older</span>
        <span>Latest</span>
      </div>
    </figure>
  );
}
