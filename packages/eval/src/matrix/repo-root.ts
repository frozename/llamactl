import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { existsSync } from "../safe-fs.js";

/** Walks up from this file's dir to find the workspace root. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml")) || existsSync(resolve(dir, ".git")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("matrix repoRoot: could not locate workspace root");
}

export function resolveCorpusPath(corpus_path: string): string {
  if (corpus_path.startsWith("/")) return corpus_path;
  return resolve(repoRoot(), corpus_path);
}
