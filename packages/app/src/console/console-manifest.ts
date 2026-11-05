// #410 P5a, bounded console manifest, no fifth module.

export type ConsoleViewId = "fleet" | "workloads" | "nodes" | "logs";

export interface ConsoleModule {
  id: ConsoleViewId;
  label: string;
  path: string;
}

export const CONSOLE_MODULES: readonly ConsoleModule[] = [
  { id: "fleet", label: "Fleet", path: "/" },
  { id: "workloads", label: "Workloads", path: "/workloads" },
  { id: "nodes", label: "Nodes", path: "/nodes" },
  { id: "logs", label: "Logs", path: "/logs" },
] as const;
