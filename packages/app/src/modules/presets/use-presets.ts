import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

import type { CandidateRowData } from "./components";
import type { ClassFilter, Preset, Profile } from "./types";

export interface UsePresetsReturn {
  promotions: ReturnType<typeof trpc.promotions.useQuery>;
  classFilter: ClassFilter;
  setClassFilter: (v: ClassFilter) => void;
  minTps: number;
  setMinTps: (v: number) => void;
  installedOnly: boolean;
  setInstalledOnly: (v: boolean) => void;
  bench: ReturnType<typeof trpc.benchCompare.useQuery>;
  pendingRel: string | null;
  setPendingRel: (v: string | null) => void;
  pickProfile: Profile;
  setPickProfile: (v: Profile) => void;
  pickPreset: Preset;
  setPickPreset: (v: Preset) => void;
  error: string | null;
  setError: (v: string | null) => void;
  copiedRel: string | null;
  promoteMutation: ReturnType<typeof trpc.promote.useMutation>;
  deleteMutation: ReturnType<typeof trpc.promoteDelete.useMutation>;
  tpsByRel: Map<string, number>;
  candidates: CandidateRowData[];
  copyStartCommand: (rel: string) => Promise<void>;
}

export function usePresets(): UsePresetsReturn {
  const queryClient = useQueryClient();
  const promotions = trpc.promotions.useQuery();
  const [classFilter, setClassFilter] = useState<ClassFilter>("all");
  const [minTps, setMinTps] = useState(0);
  const [installedOnly, setInstalledOnly] = useState(false);
  const bench = trpc.benchCompare.useQuery({ classFilter, scopeFilter: "all" });

  const [pendingRel, setPendingRel] = useState<string | null>(null);
  const [pickProfile, setPickProfile] = useState<Profile>("macbook-pro-48g");
  const [pickPreset, setPickPreset] = useState<Preset>("best");
  const [error, setError] = useState<string | null>(null);
  const [copiedRel, setCopiedRel] = useState<string | null>(null);

  const promoteMutation = trpc.promote.useMutation({
    onSuccess: async () => {
      setPendingRel(null);
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: [["promotions"], { type: "query" }],
      });
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const deleteMutation = trpc.promoteDelete.useMutation({
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: [["promotions"], { type: "query" }],
      });
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const tpsByRel = useMemo(() => {
    const m = new Map<string, number>();
    for (const row of (bench.data ?? []) as CandidateRowData[]) {
      const t = row.tuned?.gen_tps ? Number.parseFloat(row.tuned.gen_tps) : NaN;
      if (Number.isFinite(t) && t > 0) m.set(row.rel, t);
    }
    return m;
  }, [bench.data]);

  const candidates = useMemo(() => {
    const rows = [...((bench.data ?? []) as CandidateRowData[])];
    rows.sort((a, b) => {
      const ta = a.tuned?.gen_tps ? Number.parseFloat(a.tuned.gen_tps) : 0;
      const tb = b.tuned?.gen_tps ? Number.parseFloat(b.tuned.gen_tps) : 0;
      if (tb !== ta) return tb - ta;
      if (a.installed !== b.installed) return a.installed ? -1 : 1;
      return a.rel.localeCompare(b.rel);
    });
    return rows.filter((row) => {
      if (installedOnly && !row.installed) return false;
      if (minTps > 0) {
        const t = row.tuned?.gen_tps ? Number.parseFloat(row.tuned.gen_tps) : 0;
        if (!Number.isFinite(t) || t < minTps) return false;
      }
      return true;
    });
  }, [bench.data, minTps, installedOnly]);

  async function copyStartCommand(rel: string): Promise<void> {
    const cmd = `llamactl server start '${rel}'`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopiedRel(rel);
      setTimeout(() => {
        setCopiedRel((cur) => (cur === rel ? null : cur));
      }, 2000);
    } catch {
      /* clipboard disallowed */
    }
  }

  return {
    promotions,
    classFilter,
    setClassFilter,
    minTps,
    setMinTps,
    installedOnly,
    setInstalledOnly,
    bench,
    pendingRel,
    setPendingRel,
    pickProfile,
    setPickProfile,
    pickPreset,
    setPickPreset,
    error,
    setError,
    copiedRel,
    promoteMutation,
    deleteMutation,
    tpsByRel,
    candidates,
    copyStartCommand,
  };
}
