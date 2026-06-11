import { useEffect, useMemo, useState } from "react";

import { trpc, trpcUIClient } from "@/lib/trpc";
import { getProjectScanRoots, useSettingsStore } from "@/modules/settings/project-scan-roots";

import type {
  DetectedRepo,
  JournalResponse,
  ProjectListResponse,
  ProjectManifest,
  RoutingDecision,
} from "./types";

export function useProjects(): {
  list: ReturnType<typeof trpc.projectList.useQuery>;
  sorted: ProjectManifest[];
  selected: string | null;
  setSelected: (v: string | null) => void;
  selectedProject: ProjectManifest | null;
} {
  const list = trpc.projectList.useQuery(undefined, { retry: false });
  const data = list.data as ProjectListResponse | undefined;
  const rows = data?.projects ?? [];
  const [selected, setSelected] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)),
    [rows],
  );
  const selectedProject =
    selected !== null ? (sorted.find((p) => p.metadata.name === selected) ?? null) : null;

  return { list, sorted, selected, setSelected, selectedProject };
}

export function useRoutingJournal(project: string): {
  q: ReturnType<typeof trpc.projectRoutingJournal.useQuery>;
  entries: RoutingDecision[];
} {
  const q = trpc.projectRoutingJournal.useQuery(
    { tail: 50, project },
    { refetchInterval: 2000, retry: false },
  );
  const data = q.data as JournalResponse | undefined;
  const entries = data?.entries ?? [];
  return { q, entries };
}

export function useGitRepoScanner(): {
  state:
    | { kind: "loading" }
    | { kind: "ready"; repos: DetectedRepo[]; rootsShown: string[] }
    | { kind: "error"; message: string };
  expanded: boolean;
  setExpanded: (v: boolean) => void;
} {
  const projectScanRootsText = useSettingsStore((s) => s.projectScanRootsText);
  const [debouncedProjectScanRootsText, setDebouncedProjectScanRootsText] =
    useState(projectScanRootsText);
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; repos: DetectedRepo[]; rootsShown: string[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebouncedProjectScanRootsText(projectScanRootsText);
    }, 300);
    return (): void => {
      window.clearTimeout(handle);
    };
  }, [projectScanRootsText]);

  useEffect(() => {
    let cancelled = false;
    const scan = async (): Promise<void> => {
      const candidateRoots = getProjectScanRoots(debouncedProjectScanRootsText);
      const allRepos: DetectedRepo[] = [];
      const rootsShown: string[] = [];
      for (const root of candidateRoots) {
        try {
          const result = await trpcUIClient.uiScanGitRepos.query({
            root,
            maxDepth: 2,
            limit: 30,
          });
          if (cancelled) return;
          if (result.repos.length > 0) {
            rootsShown.push(result.root);
            allRepos.push(...result.repos);
          }
        } catch (err) {
          if (!cancelled) console.warn("scan failed:", root, err);
        }
      }
      if (cancelled) return;
      const seen = new Map<string, DetectedRepo>();
      for (const r of allRepos) {
        const prior = seen.get(r.path);
        if (!prior || prior.mtimeMs < r.mtimeMs) seen.set(r.path, r);
      }
      const repos = Array.from(seen.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
      setState({ kind: "ready", repos, rootsShown });
    };
    void scan();
    return (): void => {
      cancelled = true;
    };
  }, [debouncedProjectScanRootsText]);

  return { state, expanded, setExpanded };
}
