import { nodeFacts, sourceRevision } from "@llamactl/core";
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface VersionDeps {
  version: string;
  moduleDir: string;
  exec: sourceRevision.ExecFn;
  existsFn?: (p: string) => boolean;
}

export interface VersionInfo {
  version: string;
  source: boolean;
  commit: string | null;
  commitDate: string | null;
}

export function resolveVersionInfo(deps: VersionDeps): VersionInfo {
  // The repo root is resolved from the module location, not the cwd, so
  // the answer follows the running code. Compiled binaries resolve to no
  // checkout and report source:false.
  const root = sourceRevision.findRepoRoot(
    deps.moduleDir,
    deps.existsFn ? { existsFn: deps.existsFn } : {},
  );
  if (root === null) {
    return { version: deps.version, source: false, commit: null, commitDate: null };
  }
  let commit: string | null = null;
  let commitDate: string | null = null;
  try {
    const out = deps.exec("git", ["-C", root, "log", "-1", "--format=%h%x09%cs"]).trim();
    const [shortSha, date] = out.split("\t");
    if (shortSha && date) {
      commit = shortSha;
      commitDate = date;
    }
  } catch {
    // git missing or the checkout unreadable — source-only output.
  }
  return { version: deps.version, source: true, commit, commitDate };
}

export function formatVersion(info: VersionInfo): string {
  if (info.commit !== null && info.commitDate !== null) {
    return `llamactl ${info.version} (${info.commit}, ${info.commitDate}, source)`;
  }
  if (info.source) return `llamactl ${info.version} (source)`;
  return `llamactl ${info.version}`;
}

function defaultVersionDeps(): VersionDeps {
  return {
    version: nodeFacts.LLAMACTL_VERSION,
    moduleDir: dirname(fileURLToPath(import.meta.url)),
    exec: (file, args) =>
      execFileSync(file, args, {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 2000,
      }),
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- Async signature mirrors the command or client interface.
export async function runVersion(
  args: string[],
  deps: VersionDeps = defaultVersionDeps(),
): Promise<number> {
  let json = false;
  for (const arg of args) {
    switch (arg) {
      case "--json":
        json = true;
        break;
      default:
        process.stderr.write(`Unknown flag for version: ${arg}\n`);
        return 1;
    }
  }

  const info = resolveVersionInfo(deps);
  if (json) {
    process.stdout.write(`${JSON.stringify(info)}\n`);
    return 0;
  }
  process.stdout.write(`${formatVersion(info)}\n`);
  return 0;
}
