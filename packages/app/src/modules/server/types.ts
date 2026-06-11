export interface LogLine {
  kind: "launch" | "waiting" | "retry" | "ready" | "timeout" | "exited" | "done" | "error";
  text: string;
}

export const MAX_LOG_LINES = 200;
