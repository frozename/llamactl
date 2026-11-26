export type ConsoleViewId =
  | "dashboard"
  | "fleet"
  | "workloads"
  | "nodes"
  | "logs"
  | "stats"
  | "runs"
  | "chat";

export interface ConsoleModule {
  id: ConsoleViewId;
  label: string;
  path: string;
}

export const CONSOLE_MODULES: readonly ConsoleModule[] = [
  { id: "dashboard", label: "Dashboard", path: "/" },
  { id: "fleet", label: "Fleet", path: "/fleet" },
  { id: "workloads", label: "Workloads", path: "/workloads" },
  { id: "nodes", label: "Nodes", path: "/nodes" },
  { id: "logs", label: "Logs", path: "/logs" },
  { id: "stats", label: "Fleet Stats", path: "/stats" },
  { id: "runs", label: "Runs", path: "/runs" },
  { id: "chat", label: "Chat", path: "/chat" },
] as const;
