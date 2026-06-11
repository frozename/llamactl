import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Badge, Button, StatusDot } from "@/ui";

export function OpenAIConfigPanel({ node }: { node: string }): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const cfg = trpc.nodeOpenAIConfig.useQuery(
    { name: node },
    { enabled: false, retry: false, staleTime: Infinity },
  );
  const load = async (): Promise<void> => {
    if (!cfg.data) await cfg.refetch();
    setRevealed(!revealed);
  };
  return (
    <div
      style={{
        marginTop: 8,
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-2)",
        padding: 8,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 500 }}>OpenAI config</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            void load();
          }}
        >
          {revealed ? "Hide" : "Reveal"}
        </Button>
      </div>
      {revealed && cfg.data && (
        <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 11 }}>
          <div>base_url: {cfg.data.baseUrl}</div>
          <div>api_key: {cfg.data.apiKey}</div>
        </div>
      )}
    </div>
  );
}

export function NodeRow(props: {
  name: string;
  endpoint: string;
  defaultNode: string;
  kind: string;
  cloud?: { baseUrl: string } | null;
}): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const [confirmRm, setConfirmRm] = useState(false);
  const test = trpc.nodeTest.useQuery({ name: props.name }, { enabled: false, retry: false });

  const isLocalNode = props.name === "local" || props.endpoint.startsWith("inproc://");
  const probe = trpc.nodeTest.useQuery(
    { name: props.name },
    { enabled: !isLocalNode, refetchInterval: 30_000, retry: 0, staleTime: 15_000 },
  );
  const rm = trpc.nodeRemove.useMutation({
    onSuccess: () => {
      setConfirmRm(false);
      void utils.nodeList.invalidate();
      void qc.invalidateQueries();
    },
  });

  const reachability = isLocalNode
    ? "ok"
    : probe.data?.ok
      ? "ok"
      : probe.isError
        ? "fail"
        : "unknown";

  return (
    <div
      style={{
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        padding: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <StatusDot
            tone={reachability === "ok" ? "ok" : reachability === "fail" ? "err" : "idle"}
          />
          <span style={{ fontFamily: "monospace", fontSize: 14 }}>{props.name}</span>
          {props.name === props.defaultNode && <Badge variant="default">default</Badge>}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void test.refetch();
            }}
          >
            Test
          </Button>
          {props.name !== "local" &&
            (confirmRm ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    rm.mutate({ name: props.name });
                  }}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setConfirmRm(false);
                  }}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setConfirmRm(true);
                }}
              >
                Remove
              </Button>
            ))}
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: "var(--color-text-secondary)" }}>
        {props.kind === "gateway" ? "baseUrl" : "endpoint"}:{" "}
        <span style={{ fontFamily: "monospace" }}>{props.cloud?.baseUrl ?? props.endpoint}</span>
      </div>
      {props.name !== "local" && props.kind !== "provider" && (
        <OpenAIConfigPanel node={props.name} />
      )}
    </div>
  );
}
