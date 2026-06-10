#!/usr/bin/env bun
import { readFileSync } from 'node:fs';

export interface UiAuditModuleEntry {
  id: string;
  label: string;
  rootTestId?: string;
}

export interface UiAuditFunctionalReport {
  modulesTested?: number;
  network?: {
    failureCount?: number;
    failures?: unknown[];
  };
  console?: {
    count?: number;
    entries?: unknown[];
  };
  results?: Array<{
    module?: string;
    clickOk?: boolean;
  }>;
}

export function validateFunctionalReport(
  report: UiAuditFunctionalReport,
  modules: UiAuditModuleEntry[],
): string[] {
  const errors: string[] = [];
  const expected = modules.length;
  const tested = report.modulesTested ?? report.results?.length ?? 0;

  if (tested !== expected) {
    errors.push(`expected ${expected} modules, report tested ${tested}`);
  }

  const resultsByModule = new Map((report.results ?? []).map((r) => [r.module, r]));
  for (const mod of modules) {
    const result = resultsByModule.get(mod.id);
    if (!result) {
      errors.push(`missing result for module ${mod.id}`);
    }
  }

  for (const mod of modules) {
    const result = resultsByModule.get(mod.id);
    if (!result) continue;
    if (result.clickOk !== true) {
      errors.push(`module ${mod.id} navigation reported clickOk=false`);
    }
  }

  const consoleCount = report.console?.count ?? report.console?.entries?.length ?? 0;
  if (consoleCount > 0) {
    errors.push(`renderer console captured ${consoleCount} entrie(s)`);
  }

  const networkFailures =
    report.network?.failureCount ?? report.network?.failures?.length ?? 0;
  if (networkFailures > 0) {
    errors.push(`network captured ${networkFailures} failed request(s)`);
  }

  return errors;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main(argv: string[]): number {
  const [reportPath, modulesPath] = argv;
  if (!reportPath || !modulesPath) {
    console.error('Usage: check-ui-audit-functional-report.ts <report.json> <modules.json>');
    return 2;
  }

  let report: UiAuditFunctionalReport;
  let modules: UiAuditModuleEntry[];
  try {
    report = readJson(reportPath) as UiAuditFunctionalReport;
    modules = readJson(modulesPath) as UiAuditModuleEntry[];
  } catch (err) {
    console.error(`failed to read functional audit inputs: ${(err as Error).message}`);
    return 2;
  }

  const errors = validateFunctionalReport(report, modules);
  if (errors.length === 0) {
    console.log(`functional ui-audit passed: ${modules.length} modules`);
    return 0;
  }

  console.error('functional ui-audit failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
