import { createHash } from "node:crypto";
import { hostname } from "node:os";

import type { EvalEngine, EvalProvenance, ProvenanceField } from "../matrix/types.js";

import { createReadStream } from "../safe-fs.js";

/**
 * Run provenance collection (#521): every field is either a real value or
 * null paired with a non-blank reason. Nothing is ever guessed, defaulted to
 * a placeholder like "unknown", or coerced.
 */

export interface EngineVersionInfo {
  version: string | null;
  commit: string | null;
}

export interface ProvenanceReaders {
  sha256File(path: string): string | Promise<string>;
  engineVersion(binaryPath: string): EngineVersionInfo | Promise<EngineVersionInfo>;
  hostname(): string;
}

type InputReasonKey = "binary_path" | "gguf_path" | "quant" | "ctx" | "hf_revision";

export interface ProvenanceInput {
  engine: EvalEngine;
  binary_path?: string | null;
  gguf_path?: string | null;
  hf_revision?: string | null;
  quant?: string | null;
  ctx?: number | null;
  flags?: readonly string[];
  reasons?: Partial<Record<InputReasonKey, string>>;
}

const DIGEST_RE = /^[0-9a-f]{64}$/;
const ENGINE_VERSION_RE = /version:?\s+(\S+)(?:\s+\(([0-9a-f]{7,40})\))?/i;
const HF_SNAPSHOT_RE = /\/snapshots\/([0-9a-f]{40,})\//;
const VERSION_TIMEOUT_MS = 5000;

interface Draft {
  engine_version: string | null;
  engine_commit: string | null;
  binary_sha256: string | null;
  gguf_sha256: string | null;
  hf_revision: string | null;
  quant: string | null;
  ctx: number | null;
  unavailable: Partial<Record<ProvenanceField, string>>;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.trim() !== "") return err.message;
  return String(err);
}

function trimOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function reasonFor(input: ProvenanceInput, key: InputReasonKey, fallback: string): string {
  return trimOrNull(input.reasons?.[key]) ?? fallback;
}

async function readDigest(
  readers: ProvenanceReaders,
  path: string,
  label: string,
): Promise<{ value: string | null; reason: string | null }> {
  let raw: string;
  try {
    raw = await readers.sha256File(path);
  } catch (err) {
    return { value: null, reason: `${label} sha256 failed: ${errorMessage(err)}` };
  }
  const digest = raw.toLowerCase();
  if (!DIGEST_RE.test(digest)) {
    return { value: null, reason: `${label} sha256 reader did not return a 64-hex digest` };
  }
  return { value: digest, reason: null };
}

async function readEngineVersion(
  readers: ProvenanceReaders,
  binary: string,
): Promise<{ info: EngineVersionInfo; reason: string | null }> {
  try {
    const info = await readers.engineVersion(binary);
    return {
      info: { version: trimOrNull(info.version), commit: trimOrNull(info.commit) },
      reason: null,
    };
  } catch (err) {
    return {
      info: { version: null, commit: null },
      reason: `engine version probe failed: ${errorMessage(err)}`,
    };
  }
}

function collectBinaryFields(input: ProvenanceInput, draft: Draft): string | null {
  const binary = trimOrNull(input.binary_path);
  if (binary !== null) return binary;
  const reason = reasonFor(input, "binary_path", "no engine binary path supplied");
  draft.binary_sha256 = null;
  draft.engine_version = null;
  draft.engine_commit = null;
  draft.unavailable.binary_sha256 = reason;
  draft.unavailable.engine_version = reason;
  draft.unavailable.engine_commit = reason;
  return null;
}

async function readBinaryFields(
  readers: ProvenanceReaders,
  binary: string,
  draft: Draft,
): Promise<void> {
  const versioned = await readEngineVersion(readers, binary);
  draft.engine_version = versioned.info.version;
  draft.engine_commit = versioned.info.commit;
  if (versioned.reason !== null) {
    draft.unavailable.engine_version = versioned.reason;
    draft.unavailable.engine_commit = versioned.reason;
  } else {
    if (draft.engine_version === null) {
      draft.unavailable.engine_version = "engine --version output reported no version";
    }
    if (draft.engine_commit === null) {
      draft.unavailable.engine_commit = "engine --version output reported no commit";
    }
  }
  const digest = await readDigest(readers, binary, "binary");
  draft.binary_sha256 = digest.value;
  if (digest.reason !== null) draft.unavailable.binary_sha256 = digest.reason;
}

async function collectBinarySection(
  input: ProvenanceInput,
  readers: ProvenanceReaders,
  draft: Draft,
): Promise<void> {
  const binary = collectBinaryFields(input, draft);
  if (binary !== null) await readBinaryFields(readers, binary, draft);
}

async function collectGgufSection(
  input: ProvenanceInput,
  readers: ProvenanceReaders,
  draft: Draft,
): Promise<string | null> {
  const gguf = trimOrNull(input.gguf_path);
  if (gguf === null) {
    draft.unavailable.gguf_sha256 = reasonFor(
      input,
      "gguf_path",
      "no GGUF path supplied; the GGUF sha256 cannot be computed",
    );
    return null;
  }
  const digest = await readDigest(readers, gguf, "gguf");
  draft.gguf_sha256 = digest.value;
  if (digest.reason !== null) draft.unavailable.gguf_sha256 = digest.reason;
  return gguf;
}

function collectHfRevision(input: ProvenanceInput, gguf: string | null, draft: Draft): void {
  const explicit = trimOrNull(input.hf_revision);
  if (explicit !== null) {
    draft.hf_revision = explicit;
    return;
  }
  if (gguf === null) {
    draft.unavailable.hf_revision = reasonFor(
      input,
      "hf_revision",
      "no GGUF path supplied; HF revision cannot be derived",
    );
    return;
  }
  const derived = hfRevisionFromPath(gguf);
  if (derived !== null) {
    draft.hf_revision = derived;
    return;
  }
  draft.unavailable.hf_revision = reasonFor(
    input,
    "hf_revision",
    "gguf path is not under an HF snapshots/<rev>/ directory",
  );
}

function collectQuant(input: ProvenanceInput, draft: Draft): void {
  const quant = trimOrNull(input.quant);
  if (quant !== null) {
    draft.quant = quant;
    return;
  }
  draft.unavailable.quant = reasonFor(
    input,
    "quant",
    input.quant === undefined || input.quant === null
      ? "no quant label supplied"
      : "quant label is blank",
  );
}

function collectCtx(input: ProvenanceInput, draft: Draft): void {
  const ctx = input.ctx;
  if (typeof ctx === "number" && Number.isInteger(ctx) && ctx > 0) {
    draft.ctx = ctx;
    return;
  }
  draft.unavailable.ctx = reasonFor(input, "ctx", "no positive integer context size supplied");
}

/** What `collectEvalProvenance` returns: always emits `unavailable` (possibly
 *  empty) and keeps it string-indexable so callers can probe fields by name
 *  without a cast. Still structurally an EvalProvenance. */
export type CollectedEvalProvenance = EvalProvenance & {
  unavailable: Record<string, string | undefined>;
};

export async function collectEvalProvenance(
  input: ProvenanceInput,
  readers: ProvenanceReaders,
): Promise<CollectedEvalProvenance> {
  const draft: Draft = {
    engine_version: null,
    engine_commit: null,
    binary_sha256: null,
    gguf_sha256: null,
    hf_revision: null,
    quant: null,
    ctx: null,
    unavailable: {},
  };
  await collectBinarySection(input, readers, draft);
  const gguf = await collectGgufSection(input, readers, draft);
  collectHfRevision(input, gguf, draft);
  collectQuant(input, draft);
  collectCtx(input, draft);
  return {
    engine: input.engine,
    engine_version: draft.engine_version,
    engine_commit: draft.engine_commit,
    binary_sha256: draft.binary_sha256,
    gguf_sha256: draft.gguf_sha256,
    hf_revision: draft.hf_revision,
    quant: draft.quant,
    ctx: draft.ctx,
    flags: [...(input.flags ?? [])],
    host: readers.hostname(),
    unavailable: draft.unavailable,
  };
}

export function parseEngineVersionOutput(text: string): EngineVersionInfo {
  const match = ENGINE_VERSION_RE.exec(text);
  if (match === null) return { version: null, commit: null };
  return { version: match[1] ?? null, commit: match[2] ?? null };
}

export function hfRevisionFromPath(path: string): string | null {
  const match = HF_SNAPSHOT_RE.exec(path);
  return match?.[1] ?? null;
}

export interface ProvenanceSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export type SpawnEngineVersion = (
  argv: string[],
  timeoutMs: number,
) => Promise<ProvenanceSpawnResult>;

export interface ProvenanceReaderOptions {
  spawnVersion?: SpawnEngineVersion;
  /** Timeout for the `--version` probe; defaults to 5000ms. */
  versionTimeoutMs?: number;
}

/** Spawns `argv`, killing the child and rejecting if it outlives `timeoutMs`. */
async function defaultSpawnVersion(
  argv: string[],
  timeoutMs: number,
): Promise<ProvenanceSpawnResult> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const outputs = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // A killed child can make the pending reads reject after the race settled.
  outputs.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`engine version command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });
  try {
    const [stdout, stderr, exitCode] = await Promise.race([outputs, timeout]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function defaultProvenanceReaders(opts: ProvenanceReaderOptions = {}): ProvenanceReaders {
  const spawnVersion = opts.spawnVersion ?? defaultSpawnVersion;
  const timeoutMs = opts.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  return {
    sha256File: async (path: string): Promise<string> => {
      const hash = createHash("sha256");
      const stream: AsyncIterable<Buffer | string> = createReadStream(path);
      for await (const chunk of stream) {
        hash.update(chunk);
      }
      return hash.digest("hex");
    },
    engineVersion: async (binaryPath: string): Promise<EngineVersionInfo> => {
      const spawned = await spawnVersion([binaryPath, "--version"], timeoutMs);
      if (spawned.exitCode !== 0) {
        const detail = trimOrNull(spawned.stderr);
        throw new Error(
          `engine --version exited with code ${String(spawned.exitCode)}` +
            (detail === null ? "" : `: ${detail.slice(0, 200)}`),
        );
      }
      return parseEngineVersionOutput(`${spawned.stdout}\n${spawned.stderr}`);
    },
    hostname,
  };
}
