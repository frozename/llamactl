export type Mode = "file" | "candidate" | "test";
export type Profile = "mac-mini-16g" | "balanced" | "macbook-pro-48g";

export const PROFILES: readonly Profile[] = ["mac-mini-16g", "balanced", "macbook-pro-48g"];
export const MAX_LOG_LINES = 250;

export interface PullCardSpec {
  id: string;
  mode: Mode;
  repo: string;
  file?: string;
  profile?: Profile;
}

export interface LogLine {
  kind: "stdout" | "stderr" | "start" | "exit" | "done" | "error" | "profile";
  text: string;
}
