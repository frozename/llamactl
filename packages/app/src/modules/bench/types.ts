// packages/app/src/modules/bench/types.ts
export type Mode = "auto" | "text" | "vision";
export type RunKind = "preset" | "vision";

export interface LogLine {
  kind: "stdout" | "stderr" | "start" | "profile" | "done" | "error";
  text: string;
}
