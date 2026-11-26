// scripts/tooling/lint-baseline-lib.ts
// Core of lint-baseline.ts: runs eslint over the repo with a bounded heap,
// aggregates its JSON report, and writes docs/quality/lint-baseline-<date>.json.

import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

import { mkdirSync, writeFileSync } from "../safe-fs.js";

type RuleCounts = {
  errors: number;
  warnings: number;
};

type LintMessage = {
  readonly ruleId: string | null;
  readonly severity: number;
};

export type LintResult = {
  readonly filePath: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly messages: readonly LintMessage[];
};

export type Baseline = {
  totals: RuleCounts;
  byRule: Record<string, RuleCounts>;
  byFile: Record<string, RuleCounts>;
};

export type RunLintBaselineOpts = {
  readonly root: string;
  readonly eslintBin: string;
  readonly outDir: string;
  readonly now: Date;
  readonly env: Readonly<Record<string, string | undefined>>;
};

const MISSING_RULE_KEY = "(no-rule-id)";
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const ESLINT_TIMEOUT_MS = 10 * 60 * 1000;
// Matches check.yml's Lint step (PR #668): eslint's default heap OOMs on the
// macos-latest runner, which is the #846 failure in cross-repo-smoke.
const HEAP_FLAG = "--max-old-space-size";
const HEAP_LIMIT = `${HEAP_FLAG}=4096`;

function bumpCount(bucket: Record<string, RuleCounts>, key: string, severity: number): void {
  const current = bucket[key] ?? { errors: 0, warnings: 0 };
  if (severity === 2) {
    current.errors += 1;
  } else if (severity === 1) {
    current.warnings += 1;
  }
  bucket[key] = current;
}

export function buildBaseline(results: readonly LintResult[], root: string): Baseline {
  const baseline: Baseline = {
    totals: { errors: 0, warnings: 0 },
    byRule: {},
    byFile: {},
  };
  for (const result of results) {
    baseline.totals.errors += result.errorCount;
    baseline.totals.warnings += result.warningCount;
    baseline.byFile[relative(root, result.filePath)] = {
      errors: result.errorCount,
      warnings: result.warningCount,
    };
    for (const message of result.messages) {
      bumpCount(baseline.byRule, message.ruleId ?? MISSING_RULE_KEY, message.severity);
    }
  }
  return baseline;
}

/**
 * Returns a copy of `env` whose NODE_OPTIONS carries a heap ceiling for the
 * eslint child. An operator-supplied --max-old-space-size wins.
 */
export function eslintEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = { ...env };
  const current = (env["NODE_OPTIONS"] ?? "").trim();
  if (!current.includes(HEAP_FLAG)) {
    result["NODE_OPTIONS"] = current.length > 0 ? `${current} ${HEAP_LIMIT}` : HEAP_LIMIT;
  }
  return result;
}

export function formatDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Runs eslint, writes the dated baseline under outDir, and returns its path. */
export function runLintBaseline(opts: RunLintBaselineOpts): string {
  const proc = spawnSync(opts.eslintBin, [".", "--format", "json"], {
    cwd: opts.root,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER_BYTES,
    timeout: ESLINT_TIMEOUT_MS,
    env: eslintEnv(opts.env),
  });
  const describe = (): string =>
    `status=${String(proc.status)}, signal=${String(proc.signal)}` +
    (proc.error === undefined ? "" : `, error=${proc.error.message}`);
  const stderr = typeof proc.stderr === "string" ? proc.stderr : "";

  // eslint exits 0 (clean) or 1 (violations found); anything else, including a
  // signal kill such as the V8 OOM abort, is a crash.
  if (proc.error !== undefined || (proc.status !== 0 && proc.status !== 1)) {
    throw new Error(`eslint exited unexpectedly (${describe()}):\n${stderr}`);
  }
  const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
  if (stdout.trim().length === 0) {
    throw new Error(`eslint did not produce JSON on stdout (${describe()}):\n${stderr}`);
  }

  const baseline = buildBaseline(JSON.parse(stdout) as LintResult[], opts.root);
  const outputPath = join(opts.outDir, `lint-baseline-${formatDate(opts.now)}.json`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
  return outputPath;
}
