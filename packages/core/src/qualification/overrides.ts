// Pin/freeze/applied override rows for the qualification lifecycle
// (frozename/llamactl#518). Mirrors the preset-overrides TSV pattern in
// presets.ts, keyed on (rel, action) instead of (profile, preset). A
// `pin` holds a rel at a stage, a `freeze` blocks promotion with no
// stage, and an `applied` records the stage a gated apply actually
// reached, written by writeAppliedStage.

import { join } from "node:path";
import { z } from "zod";

import type { ResolvedEnv } from "../types.js";
import type { QualificationStage } from "./stages.js";

import { resolveRuntimeDir } from "../env.js";
import { atomicWriteFile } from "../fsAtomic.js";
import { readFileSync, unlinkSync } from "../safe-fs.js";
import { formatTsvRow, QUALIFICATION_STAGES, splitTsvRow } from "../schemas.js";

export const qualificationOverrideFields = [
  "rel",
  "action",
  "stage",
  "author",
  "reason",
  "updated_at",
] as const;

const TSV_UNSAFE = /[\t\n\r]/;

/**
 * One override row. `pin` freezes promotion while declaring the stage
 * the model is held at; `freeze` blocks promotion and must carry no
 * stage; `applied` records the stage a gated apply reached and requires
 * a stage like `pin`. Tab/newline-free keys keep the TSV wire format
 * parseable.
 */
export const QualificationOverride = z
  .object({
    rel: z.string().min(1),
    action: z.enum(["pin", "freeze", "applied"]),
    stage: z.union([z.enum(QUALIFICATION_STAGES), z.literal("")]),
    author: z.string().min(1),
    reason: z.string().min(1),
    updated_at: z.string().default(""),
  })
  .superRefine((row, ctx) => {
    for (const field of ["rel", "author", "reason"] as const) {
      if (TSV_UNSAFE.test(row[field])) {
        ctx.addIssue({
          code: "custom",
          message: `${field} must not contain tabs or newlines`,
          path: [field],
        });
      }
    }
    if ((row.action === "pin" || row.action === "applied") && row.stage === "") {
      ctx.addIssue({
        code: "custom",
        message: `${row.action} requires a non-empty stage`,
        path: ["stage"],
      });
    }
    if (row.action === "freeze" && row.stage !== "") {
      ctx.addIssue({ code: "custom", message: "freeze must not carry a stage", path: ["stage"] });
    }
  });
export type QualificationOverride = z.infer<typeof QualificationOverride>;

export type QualificationOverrideAction = QualificationOverride["action"];

/**
 * Read every row, tolerating missing files, blank lines and `#`
 * comments. Rows with fewer than the five required columns are skipped,
 * a missing `updated_at` pads to empty, and invalid rows are dropped
 * silently so one bad line doesn't blow up the whole file read.
 */
export function readQualificationOverrides(file: string): QualificationOverride[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: QualificationOverride[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const cols = splitTsvRow(line);
    if (cols.length < qualificationOverrideFields.length - 1) continue;
    const record: Record<string, string> = {};
    for (const [i, field] of qualificationOverrideFields.entries()) {
      record[field] = cols[i] ?? "";
    }
    const parsed = QualificationOverride.safeParse(record);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Write an override row, replacing the existing `(rel, action)` row in
 * place when present. Validation runs before any IO, so an invalid row
 * never touches the file. The file is rewritten from the parsed rows,
 * mirroring writePresetOverride: `#` comments and invalid rows present
 * before the write do not survive it. Returns the persisted row; a
 * non-void return keeps the contract test's `expect(() => fn(...))`
 * shorthand lint-clean under `no-confusing-void-expression`
 * (frozename/llamactl#518).
 */
export function writeQualificationOverride(
  file: string,
  row: Omit<QualificationOverride, "updated_at">,
  updatedAt: string = new Date().toISOString(),
): QualificationOverride {
  const parsed = QualificationOverride.parse({ ...row, updated_at: updatedAt });
  const existing = readQualificationOverrides(file);
  const next = existing
    .filter((r) => !(r.rel === parsed.rel && r.action === parsed.action))
    .concat([parsed]);
  const body = next.map((r) => formatTsvRow(qualificationOverrideFields, r)).join("\n");
  atomicWriteFile(file, body === "" ? "" : `${body}\n`);
  return parsed;
}

/**
 * Record an applied stage transition as the `(rel, "applied")` row.
 * Structurally typed on the proposal shape shared by promotion and
 * demotion, so nothing is imported from those modules and no cycle is
 * created (frozename/llamactl#518). Validation still runs before any IO:
 * an unsafe evidenceRef (or any invalid field) throws without touching
 * the file.
 */
export function writeAppliedStage(
  file: string,
  applied: { rel: string; from: QualificationStage; to: QualificationStage; evidenceRef?: string },
  author: string,
  updatedAt: string = new Date().toISOString(),
): QualificationOverride {
  const evidence = applied.evidenceRef === undefined ? "" : ` (evidence: ${applied.evidenceRef})`;
  return writeQualificationOverride(
    file,
    {
      rel: applied.rel,
      action: "applied",
      stage: applied.to,
      author,
      reason: `applied ${applied.from} -> ${applied.to}${evidence}`,
    },
    updatedAt,
  );
}

/**
 * Remove the `(rel, action)` row if present. Returns `true` only when
 * a row was actually removed. Deletes the file entirely when no rows
 * remain, mirroring deletePresetOverride. Like
 * writeQualificationOverride, the rewrite drops `#` comments and
 * invalid rows that predate the delete.
 */
export function deleteQualificationOverride(
  file: string,
  rel: string,
  action: QualificationOverrideAction,
): boolean {
  const existing = readQualificationOverrides(file);
  const next = existing.filter((r) => !(r.rel === rel && r.action === action));
  if (next.length === existing.length) return false;
  if (next.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // File already absent — still counts as "the row is gone".
    }
    return true;
  }
  const body = next.map((r) => formatTsvRow(qualificationOverrideFields, r)).join("\n");
  atomicWriteFile(file, `${body}\n`);
  return true;
}

/** Group a rel's rows into its optional pin, freeze and applied overrides. */
export function overridesFor(
  rows: readonly QualificationOverride[],
  rel: string,
): {
  pin?: QualificationOverride;
  freeze?: QualificationOverride;
  applied?: QualificationOverride;
} {
  const grouped: {
    pin?: QualificationOverride;
    freeze?: QualificationOverride;
    applied?: QualificationOverride;
  } = {};
  for (const row of rows) {
    if (row.rel !== rel) continue;
    switch (row.action) {
      case "pin":
        grouped.pin = row;
        break;
      case "freeze":
        grouped.freeze = row;
        break;
      case "applied":
        grouped.applied = row;
        break;
    }
  }
  return grouped;
}

const OVERRIDES_FILE_ENV = "LOCAL_AI_QUALIFICATION_OVERRIDES_FILE";
const OVERRIDES_FILE_NAME = "qualification-overrides.tsv";

function overridesFileFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const fromEnv = env[OVERRIDES_FILE_ENV];
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Resolve the overrides file — LOCAL_AI_QUALIFICATION_OVERRIDES_FILE >
 * `qualification-overrides.tsv` under the runtime dir. Deliberately not
 * a resolveEnv key (frozename/llamactl#518).
 */
export function qualificationOverridesFile(env: NodeJS.ProcessEnv = process.env): string {
  return overridesFileFromEnv(env) ?? join(resolveRuntimeDir(env), OVERRIDES_FILE_NAME);
}

/**
 * The overrides file routing reads for `resolved` — the one resolver
 * shared by `catalogQualificationStages` and the OpenAI proxy's
 * `/v1/models` cache signature, so the file read and the file statted
 * can never diverge. LOCAL_AI_QUALIFICATION_OVERRIDES_FILE is read from
 * `process.env` because it is not a ResolvedEnv key; otherwise
 * `qualification-overrides.tsv` under the resolved runtime dir.
 */
export function qualificationOverridesFileFor(resolved: ResolvedEnv): string {
  return (
    overridesFileFromEnv(process.env) ?? join(resolved.LOCAL_AI_RUNTIME_DIR, OVERRIDES_FILE_NAME)
  );
}
