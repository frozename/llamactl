import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Locate an `mmproj*.gguf` sibling inside the given model directory.
 * Phase 1 ports the existence check only — the best-match scoring in
 * the shell helper (GGUF metadata inspection, arch matching) is NOT
 * ported yet because its only consumer is the server-start path which
 * is a later phase. Consumers that just need "is this model vision
 * capable?" (e.g. bench mode detection) get a truthful answer today.
 */
export function findLocalMmproj(modelDir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(modelDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lower.endsWith('.gguf')) continue;
    if (lower.startsWith('mmproj') || lower.includes('mmproj')) {
      return join(modelDir, name);
    }
  }
  return null;
}

/** Convenience wrapper: derive the dir from a rel path. */
export function findLocalMmprojForRel(
  modelsRoot: string,
  rel: string,
): string | null {
  const sep = rel.lastIndexOf('/');
  if (sep < 0) return null;
  return findLocalMmproj(join(modelsRoot, rel.slice(0, sep)));
}
