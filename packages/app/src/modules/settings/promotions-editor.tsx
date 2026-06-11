import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, Input } from "@/ui";

import type { Preset, PresetOverride, Profile } from "./types";

import { PRESETS, PROFILES } from "./types";

const fieldLabelStyle: React.CSSProperties = {
  marginBottom: 4,
  display: "block",
  fontSize: 12,
  color: "var(--color-text-secondary)",
};

const selectStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: 4,
  border: "1px solid var(--color-border)",
  background: "var(--color-surface-2)",
  padding: "4px 8px",
  fontFamily: "var(--font-mono)",
};

export function PromotionsEditor(): React.JSX.Element {
  const queryClient = useQueryClient();
  const promotions = trpc.promotions.useQuery();
  const catalog = trpc.catalogList.useQuery("all");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: [["promotions"], { type: "query" }] });
  };

  const promoteMutation = trpc.promote.useMutation({
    onSuccess: async () => {
      setError(null);
      await invalidate();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const deleteMutation = trpc.promoteDelete.useMutation({
    onSuccess: async () => {
      setPendingDelete(null);
      await invalidate();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const rows = promotions.data ?? [];
  const busy = promoteMutation.isPending || deleteMutation.isPending;

  return (
    <section>
      <h2
        style={{
          marginBottom: 8,
          fontSize: 14,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.025em",
          color: "var(--color-text-secondary)",
        }}
      >
        Preset promotions ({rows.length})
      </h2>
      {error && (
        <div
          style={{
            marginBottom: 12,
            borderRadius: 6,
            border: "1px solid var(--color-err)",
            background: "var(--color-surface-1)",
            padding: "8px 12px",
            fontSize: 14,
            color: "var(--color-err)",
          }}
        >
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <div
          style={{
            marginBottom: 16,
            borderRadius: 6,
            border: "1px dashed var(--color-border)",
            padding: 16,
            color: "var(--color-text-secondary)",
          }}
        >
          No active promotions. Use the form below or{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>llamactl catalog promote</span> to add
          one.
        </div>
      ) : (
        <PromotionsTable
          rows={rows}
          busy={busy}
          pendingDelete={pendingDelete}
          setPendingDelete={setPendingDelete}
          onDelete={(p) => {
            deleteMutation.mutate({ profile: p.profile, preset: p.preset });
          }}
        />
      )}
      <PromotionForm
        busy={busy}
        promoteMutation={promoteMutation}
        setError={setError}
        catalogRels={useMemo(() => (catalog.data ?? []).map((row) => row.rel), [catalog.data])}
      />
    </section>
  );
}

function PromotionsTable({
  rows,
  busy,
  pendingDelete,
  setPendingDelete,
  onDelete,
}: {
  rows: PresetOverride[];
  busy: boolean;
  pendingDelete: string | null;
  setPendingDelete: (v: string | null) => void;
  onDelete: (p: PresetOverride) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        marginBottom: 16,
        overflow: "hidden",
        borderRadius: 6,
        border: "1px solid var(--color-border)",
      }}
    >
      <table
        style={{
          width: "100%",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          borderCollapse: "collapse",
        }}
      >
        <thead
          style={{
            background: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Profile</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Preset</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Rel</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Updated</th>
            <th
              style={{ width: 112, padding: "8px 12px", fontWeight: 500, textAlign: "right" }}
            ></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p: PresetOverride) => {
            const key = `${p.profile}:${p.preset}`;
            const isPending = pendingDelete === key;
            return (
              <tr
                key={key}
                style={{
                  borderTop: "1px solid var(--color-border)",
                  background: "var(--color-surface-1)",
                }}
              >
                <td style={{ padding: "8px 12px", color: "var(--color-brand)" }}>{p.profile}</td>
                <td style={{ padding: "8px 12px" }}>{p.preset}</td>
                <td
                  style={{ padding: "8px 12px", color: "var(--color-ok)", wordBreak: "break-all" }}
                >
                  {p.rel}
                </td>
                <td style={{ padding: "8px 12px", color: "var(--color-text-secondary)" }}>
                  {p.updated_at}
                </td>
                <td style={{ padding: "8px 12px", textAlign: "right" }}>
                  {isPending ? (
                    <span style={{ display: "inline-flex", gap: 4 }}>
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          onDelete(p);
                        }}
                      >
                        Confirm
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setPendingDelete(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setPendingDelete(key);
                      }}
                      aria-label={`Remove promotion ${key}`}
                    >
                      Remove
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PromotionForm({
  busy,
  promoteMutation,
  setError,
  catalogRels,
}: {
  busy: boolean;
  promoteMutation: ReturnType<typeof trpc.promote.useMutation>;
  setError: (v: string | null) => void;
  catalogRels: string[];
}): React.JSX.Element {
  const [profile, setProfile] = useState<Profile>("macbook-pro-48g");
  const [preset, setPreset] = useState<Preset>("best");
  const [rel, setRel] = useState("");

  const handleSubmit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    setError(null);
    if (!rel.trim()) {
      setError("Rel is required");
      return;
    }
    promoteMutation.mutate({ profile, preset, rel: rel.trim() });
    setRel("");
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        borderRadius: 6,
        border: "1px solid var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 16,
      }}
    >
      <div
        style={{
          marginBottom: 12,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.025em",
          color: "var(--color-text-secondary)",
        }}
      >
        Add / update promotion
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 12 }}>
        <label style={{ gridColumn: "span 3 / span 3", fontSize: 14 }}>
          <span style={fieldLabelStyle}>Profile</span>
          <select
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as Profile);
            }}
            disabled={busy}
            style={selectStyle}
          >
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ gridColumn: "span 2 / span 2", fontSize: 14 }}>
          <span style={fieldLabelStyle}>Preset</span>
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value as Preset);
            }}
            disabled={busy}
            style={selectStyle}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label style={{ gridColumn: "span 5 / span 5", fontSize: 14 }}>
          <span style={fieldLabelStyle}>Rel</span>
          <Input
            list="rel-suggestions"
            value={rel}
            onChange={(e) => {
              setRel(e.target.value);
            }}
            disabled={busy}
            placeholder="e.g. gemma-4-31B-it-GGUF/gemma-4-31B-it-UD-Q4_K_XL.gguf"
            style={{ fontFamily: "var(--font-mono)" }}
          />
          <datalist id="rel-suggestions">
            {catalogRels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <div style={{ gridColumn: "span 2 / span 2", display: "flex", alignItems: "flex-end" }}>
          <Button type="submit" variant="primary" disabled={busy} style={{ width: "100%" }}>
            {promoteMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: "var(--color-text-secondary)" }}>
        Existing (profile, preset) pairs are replaced in place. Rels autocomplete from the catalog.
      </div>
    </form>
  );
}
