import * as React from "react";

import { KeepAliveSupervisor, ServerControlForm, ServerLog, ServerStatusCards } from "./components";
import { useServerControl } from "./use-server-control";

/**
 * llama.cpp lifecycle control module.
 */

export default function Server(): React.JSX.Element {
  const serverObj = useServerControl();
  const { workload, workloadLoading, error } = serverObj;

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="models-server-root">
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Server
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: "var(--color-text)" }}>
        llama.cpp lifecycle
      </h1>

      <ServerStatusCards serverObj={serverObj} />

      <ServerControlForm serverObj={serverObj} />

      {error && <ServerError error={error} />}

      {!workload && !workloadLoading && <NoWorkloadMessage />}

      <KeepAliveSupervisor serverObj={serverObj} />

      <ServerLog serverObj={serverObj} />
    </div>
  );
}

function ServerError({ error }: { error: string }): React.JSX.Element {
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

function NoWorkloadMessage(): React.JSX.Element {
  return (
    <div
      style={{
        marginBottom: 12,
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: "8px 12px",
        fontSize: 14,
        color: "var(--color-text-secondary)",
      }}
    >
      No active workload. Apply one to enable this view.
    </div>
  );
}
