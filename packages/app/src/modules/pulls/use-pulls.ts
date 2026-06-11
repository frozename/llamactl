import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import type { Mode, Profile, PullCardSpec } from "./types";

export interface UsePullsReturn {
  mode: Mode;
  setMode: (v: Mode) => void;
  repo: string;
  setRepo: (v: string) => void;
  file: string;
  setFile: (v: string) => void;
  profile: Profile | "";
  setProfile: (v: Profile | "") => void;
  error: string | null;
  setError: (v: string | null) => void;
  cards: PullCardSpec[];
  enqueue: () => void;
  onDismiss: (id: string) => void;
  onDone: () => void;
  activeCount: number;
}

export function usePulls(): UsePullsReturn {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>("file");
  const [repo, setRepo] = useState("");
  const [file, setFile] = useState("");
  const [profile, setProfile] = useState<Profile | "">("");
  const [error, setError] = useState<string | null>(null);
  const [cards, setCards] = useState<PullCardSpec[]>([]);

  const enqueue = (): void => {
    const r = repo.trim();
    if (!r) {
      setError("Repo is required");
      return;
    }
    if (mode === "file" && !file.trim()) {
      setError("File is required for pull-file");
      return;
    }
    setError(null);
    const id = `${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`;
    const spec: PullCardSpec = {
      id,
      mode,
      repo: r,
      file: mode === "file" ? file.trim() : file.trim() || undefined,
      profile: mode === "file" ? undefined : profile || undefined,
    };
    setCards((prev) => [spec, ...prev]);
    setRepo("");
    setFile("");
  };

  const onDismiss = (id: string): void => {
    setCards((prev) => prev.filter((c) => c.id !== id));
  };

  const onDone = (): void => {
    void queryClient.invalidateQueries({
      queryKey: [["catalogList"], { type: "query" }],
    });
    void queryClient.invalidateQueries({
      queryKey: [["benchHistory"], { type: "query" }],
    });
    void queryClient.invalidateQueries({
      queryKey: [["benchCompare"], { type: "query" }],
    });
  };

  const activeCount = useMemo(() => cards.length, [cards]);

  return {
    mode,
    setMode,
    repo,
    setRepo,
    file,
    setFile,
    profile,
    setProfile,
    error,
    setError,
    cards,
    enqueue,
    onDismiss,
    onDone,
    activeCount,
  };
}
