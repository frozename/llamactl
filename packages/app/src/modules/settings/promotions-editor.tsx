import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";
import { Button, Input } from "@/ui";

import type { Preset, PresetOverride, Profile } from "./types";

import { PRESETS, PROFILES } from "./types";

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
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-tight text-secondary">
        Preset promotions ({rows.length})
      </h2>
      {error && (
        <div className="mb-3 p-2 text-sm border rounded bg-surface-1 border-err text-err">
          {error}
        </div>
      )}
      {rows.length === 0 ? (
        <div className="mb-4 p-4 border border-dashed rounded text-secondary">
          No active promotions.
        </div>
      ) : (
        <div className="mb-4 overflow-hidden border rounded border-border">
          <table className="w-full font-mono text-sm border-collapse">
            <thead className="text-left bg-surface-1 text-secondary">
              <tr>
                <th className="px-3 py-2 font-medium">Profile</th>
                <th className="px-3 py-2 font-medium">Preset</th>
                <th className="px-3 py-2 font-medium">Rel</th>
                <th className="px-3 py-2 font-medium">Updated</th>
                <th className="w-28 px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p: PresetOverride) => {
                const key = `${p.profile}:${p.preset}`;
                const isPending = pendingDelete === key;
                return (
                  <tr key={key} className="border-t border-border bg-surface-1">
                    <td className="px-3 py-2 text-brand">{p.profile}</td>
                    <td className="px-3 py-2 text-primary">{p.preset}</td>
                    <td className="px-3 py-2 text-ok break-all">{p.rel}</td>
                    <td className="px-3 py-2 text-secondary">{p.updated_at}</td>
                    <td className="px-3 py-2 text-right">
                      {isPending ? (
                        <span className="inline-flex gap-1">
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              deleteMutation.mutate({ profile: p.profile, preset: p.preset });
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
    <form onSubmit={handleSubmit} className="p-4 border rounded bg-surface-1 border-border">
      <div className="mb-3 text-xs font-medium uppercase tracking-tight text-secondary">
        Add / update promotion
      </div>
      <div className="grid grid-cols-12 gap-3">
        <label className="col-span-3 text-sm">
          <span className="block mb-1 text-xs text-secondary">Profile</span>
          <select
            value={profile}
            onChange={(e) => {
              setProfile(e.target.value as Profile);
            }}
            disabled={busy}
            className="w-full px-2 py-1 font-mono border rounded bg-surface-2 border-border text-primary"
          >
            {PROFILES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-2 text-sm">
          <span className="block mb-1 text-xs text-secondary">Preset</span>
          <select
            value={preset}
            onChange={(e) => {
              setPreset(e.target.value as Preset);
            }}
            disabled={busy}
            className="w-full px-2 py-1 font-mono border rounded bg-surface-2 border-border text-primary"
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="col-span-5 text-sm">
          <span className="block mb-1 text-xs text-secondary">Rel</span>
          <Input
            list="rel-suggestions"
            value={rel}
            onChange={(e) => {
              setRel(e.target.value);
            }}
            disabled={busy}
            placeholder="e.g. gemma-4-31B-it-GGUF/..."
            className="font-mono"
          />
          <datalist id="rel-suggestions">
            {catalogRels.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </label>
        <div className="col-span-2 flex items-end">
          <Button type="submit" variant="primary" disabled={busy} className="w-full">
            {promoteMutation.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </form>
  );
}
