import * as React from 'react';

/**
 * Structured per-worker panel for the Workloads Describe drawer.
 * Surfaces the static manifest shape (node, rpcHost:rpcPort, timeout,
 * extraArgs) as a table. Renders nothing when the workload has no
 * workers (single-node case) — the drawer's raw YAML view stays the
 * only source for debugging.
 *
 * Deliberately does NOT probe live worker status. That belongs to a
 * later slice; the subtitle points operators at the CLI commands that
 * already do the live check.
 *
 * Types `workers` structurally instead of importing `ModelRunWorker`
 * from `@llamactl/remote` — keeps the app package free of a direct
 * source import (matches how the tRPC response is consumed in the
 * module today, which picks up the shape via router type inference).
 */
export interface WorkerManifest {
  readonly node: string;
  readonly rpcHost: string;
  readonly rpcPort: number;
  readonly timeoutSeconds: number;
  readonly extraArgs?: readonly string[];
}

interface WorkersPanelProps {
  readonly workers: readonly WorkerManifest[];
}

export function WorkersPanel(props: WorkersPanelProps): React.JSX.Element | null {
  const { workers } = props;
  if (workers.length === 0) return null;
  return (
    <section
      data-testid="workloads-workers-panel"
      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
    >
      <div className="font-medium text-[color:var(--color-text)]">
        Workers ({workers.length})
      </div>
      <p className="mt-0.5 text-[10px] text-[color:var(--color-text-secondary)]">
        Static manifest shape; run{' '}
        <code className="font-mono">llamactl node test &lt;name&gt;</code> or{' '}
        <code className="font-mono">
          llamactl agent rpc-doctor --node &lt;name&gt;
        </code>{' '}
        for live checks.
      </p>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full border-collapse text-[10px]">
          <thead>
            <tr className="text-left text-[color:var(--color-text-secondary)]">
              <th className="border-b border-[var(--color-border)] py-1 pr-3 font-medium">
                node
              </th>
              <th className="border-b border-[var(--color-border)] py-1 pr-3 font-medium">
                rpc endpoint
              </th>
              <th className="border-b border-[var(--color-border)] py-1 pr-3 font-medium">
                timeout (s)
              </th>
              <th className="border-b border-[var(--color-border)] py-1 font-medium">
                extra args
              </th>
            </tr>
          </thead>
          <tbody>
            {workers.map((w) => {
              const extra = w.extraArgs ?? [];
              return (
                <tr key={w.node} className="align-top">
                  <td className="py-1 pr-3 font-mono text-[color:var(--color-text)]">
                    {w.node}
                  </td>
                  <td className="py-1 pr-3 font-mono text-[color:var(--color-text)]">
                    {w.rpcHost}:{w.rpcPort}
                  </td>
                  <td className="py-1 pr-3 font-mono text-[color:var(--color-text)]">
                    {w.timeoutSeconds}
                  </td>
                  <td className="py-1 font-mono text-[color:var(--color-text)]">
                    {extra.length === 0 ? (
                      <em className="not-italic text-[color:var(--color-text-secondary)]">
                        default
                      </em>
                    ) : (
                      extra.join(' ')
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
