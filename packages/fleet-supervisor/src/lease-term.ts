import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "./safe-fs.js";

/**
 * Local path for the persisted monotonic lease term. Per-node-local — there is no
 * shared store (design §0). The term ++ on every (re)start so a restarted node
 * yields to a steadier (lower-term) peer, preventing flapping.
 */
export function defaultLeaseTermPath(): string {
  return join(homedir(), ".llamactl", "fleet", "lease-term");
}

/**
 * Read the persisted term (or 0 when absent/corrupt), increment, persist, return
 * the new value. Called once at supervisor startup (design §2 acquire). Uses only
 * the package safe-fs boundary, never raw node:fs.
 */
export function bumpLeaseTerm(path: string = defaultLeaseTermPath()): number {
  let current = 0;
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isFinite(parsed) && parsed >= 0) current = parsed;
    } catch {
      current = 0;
    }
  }
  const next = current + 1;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, String(next));
  return next;
}
