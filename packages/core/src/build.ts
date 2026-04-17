import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolveEnv } from './env.js';

/**
 * Compute an abbreviated build identifier for the current llama.cpp
 * binaries. Used as part of the bench-record primary key so tuned
 * profiles invalidate cleanly whenever the local library is rebuilt.
 *
 * Preference order, mirroring the historical shell helper:
 *   1. `git rev-parse --short HEAD` inside $LLAMA_CPP_SRC
 *   2. `bin-<mtime>` of $LLAMA_CPP_BIN/llama-server (fallback when the
 *      source tree isn't a git checkout or git fails)
 *   3. literal string `unknown`
 */
export function resolveBuildId(resolved = resolveEnv()): string {
  const { LLAMA_CPP_SRC, LLAMA_CPP_BIN } = resolved;

  try {
    const gitDir = `${LLAMA_CPP_SRC}/.git`;
    const stat = statSync(gitDir);
    if (stat.isDirectory() || stat.isFile()) {
      const out = execSync(
        `git -C ${JSON.stringify(LLAMA_CPP_SRC)} rev-parse --short HEAD`,
        { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' },
      ).trim();
      if (out.length > 0) return out;
    }
  } catch {
    // fall through
  }

  try {
    const serverBin = `${LLAMA_CPP_BIN}/llama-server`;
    const st = statSync(serverBin);
    if (st.isFile()) {
      const mtime = Math.floor(st.mtimeMs / 1000);
      return `bin-${mtime}`;
    }
  } catch {
    // fall through
  }

  return 'unknown';
}
