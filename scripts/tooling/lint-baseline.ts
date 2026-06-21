import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";

import { mkdirSync, writeFileSync } from "../safe-fs.js";

type LintMessage = {
  readonly ruleId: string | null;
  readonly severity: number;
};

type LintResult = {
  readonly errorCount: number;
  readonly warningCount: number;
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
};

type RuleCounts = {
  errors: number;
  warnings: number;
};

type Baseline = {
  totals: RuleCounts;
  byRule: Record<string, RuleCounts>;
  byFile: Record<string, RuleCounts>;
};

const root = join(import.meta.dir, "..", "..");
const ESLINT_BIN = join(root, "node_modules", ".bin", "eslint");
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;
const MISSING_RULE_KEY = "(no-rule-id)";

function formatDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function bumpCount(bucket: Record<string, RuleCounts>, key: string, severity: number): void {
  const current = bucket[key] ?? { errors: 0, warnings: 0 };
  if (severity === 2) {
    current.errors += 1;
  } else if (severity === 1) {
    current.warnings += 1;
  }
  bucket[key] = current;
}

const eslint = spawnSync(ESLINT_BIN, [".", "--format", "json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: MAX_BUFFER_BYTES,
  timeout: 10 * 60 * 1000,
});

if (eslint.status !== 0 && eslint.status !== 1) {
  throw new Error(
    `eslint exited unexpectedly (status=${String(eslint.status)}, signal=${String(eslint.signal)}):\n${eslint.stderr}`,
  );
}

if (typeof eslint.stdout !== "string" || eslint.stdout.trim().length === 0) {
  throw new Error(
    `eslint did not produce JSON on stdout (status=${String(eslint.status)}):\n${eslint.stderr}`,
  );
}

const results = JSON.parse(eslint.stdout) as LintResult[];
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
    const ruleId = message.ruleId ?? MISSING_RULE_KEY;
    bumpCount(baseline.byRule, ruleId, message.severity);
  }
}

const today = formatDate(new Date());
const outputPath = join(root, "docs/quality", `lint-baseline-${today}.json`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(baseline, null, 2) + "\n", "utf8");
process.stdout.write(`wrote ${outputPath}\n`);
