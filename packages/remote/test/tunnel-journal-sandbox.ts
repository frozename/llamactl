import { afterAll } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, rmSync } from "../src/safe-fs.js";

const OVERRIDE_KEY = "LLAMACTL_TUNNEL_JOURNAL";
const SETTLE_MS = 100;

/**
 * A per-file tunnel journal for the tunnel servers and relays a test file
 * starts. Without one they journal to the operator's real journal, which is
 * what operators read to diagnose real tunnel flaps.
 *
 * Call both helpers below once per file at its top level, useTempTunnelJournal
 * first, after the file's own top-level afterAll hooks: bun runs afterAll
 * hooks in registration order and skips the rest once one throws, so
 * registered earlier they would remove the journal before the file's servers
 * stop writing to it, or skip the file's own teardown.
 */
export interface TempTunnelJournal {
  readonly path: string;
}

interface GuardedFile {
  readonly saved: string | undefined;
  readonly fallbackDir: string;
  readonly journalDirs: readonly string[];
}

const liveJournalDirs = new Set<string>();
// Bun loads and runs test files one at a time and shares this module between
// them, so a guard call that finds this set follows a file whose own afterAll
// threw and skipped the helpers' teardown.
let unfinished: GuardedFile | undefined;

function removeJournalDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  liveJournalDirs.delete(dir);
}

function restoreOverride(saved: string | undefined): void {
  if (saved === undefined) Reflect.deleteProperty(process.env, OVERRIDE_KEY);
  else process.env[OVERRIDE_KEY] = saved;
}

/**
 * Created eagerly so harnesses built in any hook can use the path; removed in
 * afterAll, which bun runs even when a test in the file fails.
 */
export function useTempTunnelJournal(): TempTunnelJournal {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-tunnel-journal-"));
  liveJournalDirs.add(dir);
  afterAll(async () => {
    // Teardowns that stop a client without awaiting the server's close
    // handler let it journal the disconnect a moment later, and the append
    // recreates a directory removed before it.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    removeJournalDir(dir);
  });
  return { path: join(dir, "journal.jsonl") };
}

/**
 * Backstop for a server started without an explicit journal path: points
 * the default at a temporary file for the file's run, then fails the file if
 * anything landed there, so a missing path is caught rather than silently
 * absorbed. The default moves at the call rather than in a beforeAll so that
 * servers built in the file's own beforeAll hooks, which run first, see it.
 *
 * When a file's own afterAll throws, the next file's call restores the
 * variable and removes the skipped directories; after the run's last file
 * nothing does, and they stay in the temp directory.
 */
export function guardDefaultTunnelJournal(): void {
  if (unfinished !== undefined) {
    restoreOverride(unfinished.saved);
    rmSync(unfinished.fallbackDir, { recursive: true, force: true });
    for (const dir of unfinished.journalDirs) removeJournalDir(dir);
  }
  const dir = mkdtempSync(join(tmpdir(), "llamactl-tunnel-journal-default-"));
  const fallback = join(dir, "journal.jsonl");
  const file: GuardedFile = {
    saved: process.env[OVERRIDE_KEY],
    fallbackDir: dir,
    journalDirs: [...liveJournalDirs],
  };
  unfinished = file;
  process.env[OVERRIDE_KEY] = fallback;
  afterAll(() => {
    unfinished = undefined;
    restoreOverride(file.saved);
    const leaked = existsSync(fallback);
    rmSync(dir, { recursive: true, force: true });
    if (leaked) {
      throw new Error(
        `a tunnel journal write fell back to ${OVERRIDE_KEY}; pass journalPath or tunnelJournalPath explicitly`,
      );
    }
  });
}
