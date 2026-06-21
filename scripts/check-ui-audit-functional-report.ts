#!/usr/bin/env bun
import { readFileSync } from "./safe-fs.js";

export interface UiAuditModuleEntry {
  id: string;
  label: string;
  rootTestId?: string;
}

export interface UiAuditFunctionalReport {
  modulesTested?: number;
  network?: {
    failureCount?: number;
    failures?: { failed?: boolean; status?: number; method?: string; url?: string }[];
    requests?: { failed?: boolean; status?: number; method?: string; url?: string }[];
  };
  console?: {
    count?: number;
    dropped?: number;
    entries?: unknown[];
  };
  results?: { module?: string; clickOk?: boolean }[];
}

/**
 * Electron emits dev-mode security warnings (e.g. a missing Content-Security-
 * Policy) straight to the renderer console. They are framework-generated, never
 * appear in a packaged build ("will not show up once the app is packaged"), and
 * are not app-level output — so they must not fail the functional console gate.
 * Real app console output still counts.
 */
function isElectronSecurityWarning(entry: unknown): boolean {
  const text =
    entry && typeof entry === "object" && "text" in entry
      ? (entry as { text?: unknown }).text
      : undefined;
  return typeof text === "string" && /Electron Security Warning/i.test(text);
}

export function validateFunctionalReport(
  report: UiAuditFunctionalReport,
  modules: UiAuditModuleEntry[],
): string[] {
  const errors: string[] = [];
  const expected = modules.length;
  const tested = report.modulesTested ?? report.results?.length ?? 0;

  if (tested !== expected) {
    errors.push(`expected ${String(expected)} modules, report tested ${String(tested)}`);
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

  const consoleEntries = report.console?.entries;
  const consoleCount =
    consoleEntries !== undefined
      ? consoleEntries.filter((entry) => !isElectronSecurityWarning(entry)).length +
        (report.console?.dropped ?? 0)
      : (report.console?.count ?? 0);
  if (consoleCount > 0) {
    errors.push(`renderer console captured ${String(consoleCount)} entrie(s)`);
  }

  const requestEntries = report.network?.requests ?? report.network?.failures ?? [];
  const requestFailures = requestEntries.filter(
    (request) => request.failed === true || (request.status ?? 0) >= 400,
  ).length;
  const aggregateFailures = report.network?.failureCount ?? 0;
  const networkFailures = Math.max(requestFailures, aggregateFailures);
  if (networkFailures > 0) {
    errors.push(`network captured ${String(networkFailures)} failed request(s)`);
  }

  return errors;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function main(argv: string[]): number {
  const [reportPath, modulesPath] = argv;
  if (!reportPath || !modulesPath) {
    console.error("Usage: check-ui-audit-functional-report.ts <report.json> <modules.json>");
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
    process.stdout.write(`functional ui-audit passed: ${String(modules.length)} modules\n`);
    return 0;
  }

  console.error("functional ui-audit failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  return 1;
}

if (import.meta.main) {
  process.exit(main(process.argv.slice(2)));
}
