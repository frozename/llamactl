import { create } from "zustand";
import { persist } from "zustand/middleware";

export const DEFAULT_PROJECT_SCAN_ROOTS: readonly string[] = [
  "~/DevStorage/repos/personal",
  "~/DevStorage/repos/work",
  "~/DevStorage/repos",
  "~/repos",
  "~/Projects",
  "~/projects",
  "~/src",
];

const DEFAULT_PROJECT_SCAN_ROOTS_TEXT = DEFAULT_PROJECT_SCAN_ROOTS.join("\n");

interface SettingsState {
  projectScanRootsText: string;
  setProjectScanRootsText: (text: string) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      projectScanRootsText: DEFAULT_PROJECT_SCAN_ROOTS_TEXT,
      setProjectScanRootsText: (text): void => void set({ projectScanRootsText: text }),
    }),
    { name: "llamactl-settings" },
  ),
);

export function parseProjectScanRootsText(text: string): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  for (const part of text
    .split(/[\n,]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)) {
    if (seen.has(part)) continue;
    seen.add(part);
    roots.push(part);
  }
  return roots;
}

export function getProjectScanRoots(text: string): string[] {
  const roots = parseProjectScanRootsText(text);
  return roots.length > 0 ? roots : [...DEFAULT_PROJECT_SCAN_ROOTS];
}
