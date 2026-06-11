export type SourceKind = "filesystem" | "http" | "git";

export interface FilesystemSource {
  kind: "filesystem";
  root: string;
  glob: string;
  tag?: string;
}

export interface HttpSource {
  kind: "http";
  url: string;
  max_depth: number;
  same_origin: boolean;
  ignore_robots: boolean;
  rate_limit_per_sec: number;
  timeout_ms: number;
  tokenRef?: string;
  tag?: string;
}

export interface GitSource {
  kind: "git";
  repo: string;
  ref?: string;
  subpath?: string;
  glob: string;
  tokenRef?: string;
  tag?: string;
}

export type SourceState = FilesystemSource | HttpSource | GitSource;

export interface TransformState {
  chunk_size: number;
  overlap: number;
  preserve_headings: boolean;
}

export interface FormState {
  name: string;
  ragNode: string;
  collection: string;
  sources: SourceState[];
  transform: TransformState;
  schedule: string;
  on_duplicate: "skip" | "replace" | "version";
}

export type Step = "destination" | "sources" | "transforms" | "review";

export const STEPS: { id: Step; label: string }[] = [
  { id: "destination", label: "Destination" },
  { id: "sources", label: "Sources" },
  { id: "transforms", label: "Transforms" },
  { id: "review", label: "Review" },
];

export function emptySource(kind: SourceKind): SourceState {
  if (kind === "filesystem") return { kind: "filesystem", root: "", glob: "**/*.md" };
  if (kind === "http")
    return {
      kind: "http",
      url: "",
      max_depth: 2,
      same_origin: true,
      ignore_robots: false,
      rate_limit_per_sec: 2,
      timeout_ms: 10_000,
    };
  return { kind: "git", repo: "", glob: "**/*.md" };
}
