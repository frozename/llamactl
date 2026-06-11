import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, Input } from "@/ui";

type CloudProvider =
  | "openai"
  | "anthropic"
  | "together"
  | "groq"
  | "mistral"
  | "openai-compatible"
  | "sirius"
  | "embersynth";

export function RegisterCloudPanel(props: { onDone: () => void }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<CloudProvider>("openai");
  const [apiKeyRef, setApiKeyRef] = useState("$OPENAI_API_KEY");
  const [error, setError] = useState<string | null>(null);

  const add = trpc.nodeAddCloud.useMutation({
    onSuccess: () => {
      void utils.nodeList.invalidate();
      void qc.invalidateQueries();
      props.onDone();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ name: name.trim(), provider, apiKeyRef: apiKeyRef.trim() });
      }}
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500 }}>Register a cloud provider</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <Input
          type="text"
          placeholder="name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value as CloudProvider);
          }}
          style={{
            padding: "4px 8px",
            borderRadius: 4,
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="sirius">sirius</option>
          <option value="embersynth">embersynth</option>
        </select>
        <Input
          type="text"
          placeholder="API key ref"
          value={apiKeyRef}
          onChange={(e) => {
            setApiKeyRef(e.target.value);
          }}
        />
        <Button type="submit" variant="primary" disabled={add.isPending}>
          Register
        </Button>
      </div>
      {error && <div style={{ color: "var(--color-err)", fontSize: 12 }}>{error}</div>}
    </form>
  );
}

export function RegisterPanel(props: { onDone: () => void }): React.JSX.Element {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [blob, setBlob] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = trpc.nodeAdd.useMutation({
    onSuccess: () => {
      void utils.nodeList.invalidate();
      void qc.invalidateQueries();
      props.onDone();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        add.mutate({ name: name.trim(), bootstrap: blob.trim() });
      }}
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 4,
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-surface-1)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500 }}>Register a remote node</div>
      <Input
        type="text"
        placeholder="name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
        }}
      />
      <textarea
        placeholder="Paste bootstrap blob…"
        value={blob}
        onChange={(e) => {
          setBlob(e.target.value);
        }}
        style={{
          height: 100,
          width: "100%",
          borderRadius: 4,
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
          padding: "4px 8px",
        }}
      />
      <Button type="submit" variant="primary" disabled={add.isPending}>
        Register
      </Button>
      {error && <div style={{ color: "var(--color-err)", fontSize: 12 }}>{error}</div>}
    </form>
  );
}
