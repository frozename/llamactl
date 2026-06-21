import { renameSync, writeFileSync } from "./safe-fs.js";

/**
 * Write a file atomically. A bare `writeFileSync` on the target can race
 * with a concurrent reader (or a second writer for the same path) and
 * leave a truncated file on disk — and these manifest/state files are
 * read by the reconciler, the healer remediation loop, and the supervisor
 * while they are being rewritten. Write to a sibling tmp file and rename
 * over the target: a POSIX rename on the same filesystem is atomic, so a
 * reader sees either the old file or the new one, never a partial one.
 *
 * This is the canonical implementation that the workload store has used
 * since the manifest stores went file-per-name; every store should call
 * it rather than re-inlining the tmp+rename dance.
 */
export function atomicWriteFileSync(path: string, contents: string): void {
  const tmp = `${path}.tmp.${String(process.pid)}.${Math.random().toString(36).slice(2, 10)}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}
