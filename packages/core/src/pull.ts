import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { relFromRepoAndFile } from './catalog.js';
import { eligibleGgufSiblings, pickFile } from './discovery.js';
import { resolveEnv } from './env.js';
import { fetchModelInfo, mmprojFileForRepo } from './hf.js';
import { normalizeProfile, resolveProfile } from './profile.js';
import type { MachineProfile, ResolvedEnv } from './types.js';

/**
 * Resolve which HuggingFace CLI binary to invoke. Probe order:
 *   1. LOCAL_AI_HF_BIN env override (accepts an absolute path).
 *   2. Any of `hf` / `huggingface-cli` on PATH.
 *   3. Literal `hf` so the spawn fails with a clear ENOENT the caller
 *      can surface, rather than hanging on a non-existent command.
 * Exported so the Electron UI can report which binary was chosen.
 */
export function resolveHfBin(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LOCAL_AI_HF_BIN;
  if (override && override.length > 0) return override;
  const path = env.PATH ?? '';
  const candidates = ['hf', 'huggingface-cli'];
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      for (const ext of extensions) {
        const full = join(dir, `${name}${ext}`);
        if (existsSync(full)) return full;
      }
    }
  }
  return 'hf';
}

/**
 * Progress + lifecycle events emitted by a pull. Consumers shape these
 * into shell output (stderr passthrough) or tRPC observables (Electron
 * download-bar). `start` fires once before spawn; `stdout` and `stderr`
 * carry child output line-by-line (split on \n or \r to follow tqdm's
 * in-place progress bars); `exit` fires once with the final code.
 */
export type PullEvent =
  | { type: 'start'; command: 'hf'; args: string[]; target: string }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'exit'; code: number };

/**
 * Runner signature for `hf`. Overridable so tests can assert the argv
 * assembled by the pull functions without spawning a real subprocess.
 * When a caller passes a `signal`, the default runner SIGTERMs the
 * child on abort so subscription teardown can cancel in-flight pulls.
 */
export type RunHf = (
  args: string[],
  onEvent?: (e: PullEvent) => void,
  signal?: AbortSignal,
) => Promise<number>;

function repoBasename(repo: string): string {
  const slash = repo.lastIndexOf('/');
  return slash >= 0 ? repo.slice(slash + 1) : repo;
}

/**
 * Split a streaming chunk into lines on either newline or carriage
 * return. `hf download` uses tqdm for progress, which rewrites the
 * current line via `\r`; treating both as terminators lets consumers
 * surface intermediate progress states rather than waiting for the
 * final `\n`.
 */
function drainLines(
  buf: string,
  onLine: (line: string) => void,
): string {
  let remaining = buf;
  while (true) {
    const nl = remaining.indexOf('\n');
    const cr = remaining.indexOf('\r');
    let idx: number;
    if (nl === -1 && cr === -1) break;
    else if (nl === -1) idx = cr;
    else if (cr === -1) idx = nl;
    else idx = Math.min(nl, cr);
    const line = remaining.slice(0, idx);
    remaining = remaining.slice(idx + 1);
    if (line.length > 0) onLine(line);
  }
  return remaining;
}

export const defaultRunHf: RunHf = (args, onEvent, signal) => {
  return new Promise((resolve, reject) => {
    const bin = resolveHfBin();
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const forward = (
      stream: NodeJS.ReadableStream,
      kind: 'stdout' | 'stderr',
    ) => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        buf = drainLines(buf, (line) => onEvent?.({ type: kind, line }));
      });
      stream.on('end', () => {
        if (buf.length > 0) onEvent?.({ type: kind, line: buf });
      });
    };
    if (child.stdout) forward(child.stdout, 'stdout');
    if (child.stderr) forward(child.stderr, 'stderr');
    const onAbort = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // child may already be gone
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.once('exit', (code) => {
      signal?.removeEventListener('abort', onAbort);
      const c = code ?? 1;
      onEvent?.({ type: 'exit', code: c });
      resolve(c);
    });
  });
};

// ---- pull whole repo ---------------------------------------------------

export interface PullRepoOptions {
  repo: string;
  /** Override the default `$LLAMA_CPP_MODELS/<repo-basename>` target. */
  targetDir?: string;
  onEvent?: (e: PullEvent) => void;
  runHf?: RunHf;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
}

export interface PullRepoResult {
  repo: string;
  target: string;
  code: number;
}

/**
 * Bulk pull an entire HF repo. Mirrors `llama-pull` in the shell
 * library — `hf download <repo> --local-dir <target>` with a default
 * target under `$LLAMA_CPP_MODELS`.
 */
export async function pullRepo(opts: PullRepoOptions): Promise<PullRepoResult> {
  if (!opts.repo) throw new Error('pullRepo: repo is required');
  const resolved = opts.resolved ?? resolveEnv();
  const target =
    opts.targetDir && opts.targetDir.length > 0
      ? opts.targetDir
      : join(resolved.LLAMA_CPP_MODELS, repoBasename(opts.repo));
  mkdirSync(target, { recursive: true });

  const args = ['download', opts.repo, '--local-dir', target];
  opts.onEvent?.({ type: 'start', command: 'hf', args, target });
  const run = opts.runHf ?? defaultRunHf;
  const code = await run(args, opts.onEvent, opts.signal);
  return { repo: opts.repo, target, code };
}

// ---- pull single file (with mmproj auto-include) -----------------------

export interface PullFileOptions {
  repo: string;
  file: string;
  onEvent?: (e: PullEvent) => void;
  runHf?: RunHf;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
  /**
   * Skip the HF model-info lookup for the mmproj sidecar. Callers who
   * already know the repo is text-only (or who are running offline)
   * can avoid the extra round-trip. Matches the `2>/dev/null || true`
   * tolerance in the shell helper.
   */
  skipMmproj?: boolean;
}

export interface PullFileResult {
  repo: string;
  file: string;
  rel: string;
  target: string;
  /**
   * Whether the target file was absent on disk before the pull. The
   * shell's auto-tune gate keys off this — a re-pull of an already
   * present model shouldn't trigger a benchmark.
   */
  wasMissing: boolean;
  requestedFiles: string[];
  mmproj: string | null;
  code: number;
}

/**
 * Pull a single file from an HF repo into
 * `$LLAMA_CPP_MODELS/<repo-basename>/`. When the repo has an mmproj
 * projector sibling (discovered via model-info), that file is pulled
 * in the same `hf download` call so multimodal models land complete.
 * The structured result reports `wasMissing` so callers can drive
 * conditional post-pull steps like auto-tune.
 */
export async function pullRepoFile(
  opts: PullFileOptions,
): Promise<PullFileResult> {
  if (!opts.repo) throw new Error('pullRepoFile: repo is required');
  if (!opts.file) throw new Error('pullRepoFile: file is required');
  const resolved = opts.resolved ?? resolveEnv();
  const target = join(resolved.LLAMA_CPP_MODELS, repoBasename(opts.repo));
  const rel = relFromRepoAndFile(opts.repo, opts.file);
  const wasMissing = !existsSync(join(resolved.LLAMA_CPP_MODELS, rel));

  let mmproj: string | null = null;
  if (!opts.skipMmproj) {
    try {
      const info = await fetchModelInfo(opts.repo, resolved);
      if (info) mmproj = mmprojFileForRepo(info);
    } catch {
      mmproj = null;
    }
  }

  mkdirSync(target, { recursive: true });
  const requestedFiles = mmproj ? [opts.file, mmproj] : [opts.file];
  const args = ['download', opts.repo, ...requestedFiles, '--local-dir', target];
  opts.onEvent?.({ type: 'start', command: 'hf', args, target });
  const run = opts.runHf ?? defaultRunHf;
  const code = await run(args, opts.onEvent, opts.signal);

  return {
    repo: opts.repo,
    file: opts.file,
    rel,
    target,
    wasMissing,
    requestedFiles,
    mmproj,
    code,
  };
}

// ---- candidate picker --------------------------------------------------

export interface PickCandidateOptions {
  repo: string;
  /** If set, short-circuit the HF lookup and return this file verbatim. */
  file?: string;
  /** Overrides the active machine profile for ranking. */
  profile?: MachineProfile | string;
  resolved?: ResolvedEnv;
}

export interface PickCandidateResult {
  repo: string;
  file: string;
  source: 'requested' | 'picked';
  profile: MachineProfile;
  eligible: string[];
}

/**
 * Resolve a candidate GGUF file for a repo. When the caller supplies
 * `file`, it's returned as-is; otherwise we consult HF model-info,
 * filter the sibling list to usable GGUFs (drop mmproj / bf16 dirs /
 * multi-part shards), and walk the profile's quant preference ladder.
 * Returns null when HF is unreachable and no cache is warm.
 */
export async function pickCandidateFile(
  opts: PickCandidateOptions,
): Promise<PickCandidateResult | null> {
  if (!opts.repo) throw new Error('pickCandidateFile: repo is required');
  const resolved = opts.resolved ?? resolveEnv();
  const profile: MachineProfile =
    (typeof opts.profile === 'string'
      ? normalizeProfile(opts.profile)
      : opts.profile) ?? resolveProfile();

  if (opts.file) {
    return {
      repo: opts.repo,
      file: opts.file,
      source: 'requested',
      profile,
      eligible: [opts.file],
    };
  }

  const info = await fetchModelInfo(opts.repo, resolved);
  if (!info) return null;
  const eligible = eligibleGgufSiblings(info);
  const picked = pickFile(profile, eligible);
  if (!picked) return null;

  return {
    repo: opts.repo,
    file: picked,
    source: 'picked',
    profile,
    eligible,
  };
}

// ---- pick + pull (candidate) ------------------------------------------

export interface PullCandidateOptions {
  repo: string;
  file?: string;
  profile?: MachineProfile | string;
  onEvent?: (e: PullEvent) => void;
  runHf?: RunHf;
  resolved?: ResolvedEnv;
  signal?: AbortSignal;
  skipMmproj?: boolean;
}

export interface PullCandidateResult extends PullFileResult {
  picked: {
    source: 'requested' | 'picked';
    profile: MachineProfile;
    eligible: string[];
  };
}

/**
 * Pick a candidate file (via `pickCandidateFile`) and pull it (via
 * `pullRepoFile`). Mirrors `llama-pull-candidate` in the shell
 * library. Returns an `error` shape instead of throwing so the CLI
 * wrapper can translate it into a clean rc=1 + message, matching the
 * shell's "Unable to resolve a candidate file for <repo>" failure.
 */
export async function pullCandidate(
  opts: PullCandidateOptions,
): Promise<PullCandidateResult | { error: string }> {
  const pick = await pickCandidateFile({
    repo: opts.repo,
    file: opts.file,
    profile: opts.profile,
    resolved: opts.resolved,
  });
  if (!pick) return { error: `Unable to resolve a candidate file for ${opts.repo}` };

  const pulled = await pullRepoFile({
    repo: opts.repo,
    file: pick.file,
    onEvent: opts.onEvent,
    runHf: opts.runHf,
    resolved: opts.resolved,
    signal: opts.signal,
    skipMmproj: opts.skipMmproj,
  });

  return {
    ...pulled,
    picked: {
      source: pick.source,
      profile: pick.profile,
      eligible: pick.eligible,
    },
  };
}
