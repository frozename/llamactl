import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Atomically replace a file's contents. Uses a tmp file in the SAME
 * directory as the target and a rename, which guarantees atomicity
 * per POSIX without tripping EXDEV on external-volume layouts where
 * `$TMPDIR` lives on a different filesystem than the target.
 */
export function atomicWriteFile(file: string, body: string): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${file.slice(dir.length + 1)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  writeFileSync(tmp, body);
  renameSync(tmp, file);
}

/**
 * Append a single line to a file, creating it + its parent dir if
 * needed. Not atomic (append is not meaningful to atomicise against
 * concurrent appenders), but cheap and matches the shell library's
 * `printf '...' >> $file` pattern for catalog entries and bench rows.
 */
export function appendLine(file: string, line: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const suffix = line.endsWith('\n') ? '' : '\n';
  appendFileSync(file, line + suffix);
}
