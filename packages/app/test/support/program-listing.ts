// packages/app/test/support/program-listing.ts
// Issue #777: under bun, tsc's process.exit drops stdout writes still buffered
// when stdout is a pipe (measured: 535 of 1667 lines through a slow pipe), so
// the RED 2a listing goes to a regular file, where writes are synchronous.
// Test-only support; no src change.

import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, readFileSync, rmSync } from "../../src/safe-fs.js";

export function captureStdoutToFile(opts: { cmd: string[]; cwd?: string; tmpRoot?: string }): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "llamactl-listing-"));
  const out = join(dir, "stdout.txt");
  try {
    const proc = Bun.spawnSync({
      cmd: opts.cmd,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      stdout: Bun.file(out),
      stderr: "pipe",
    });
    return {
      exitCode: proc.exitCode,
      stdout: readFileSync(out, "utf8"),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function splitListing(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

export function describeListing(lines: readonly string[], tail = 5): string {
  const count = String(lines.length);
  const shownCount = String(Math.min(tail, lines.length));
  const tailText = lines.slice(-tail).join("\n");
  return `captured ${count} lines; last ${shownCount}:\n${tailText}`;
}
