import { describe, expect, test } from "bun:test";

import {
  validateFunctionalReport,
  type UiAuditFunctionalReport,
  type UiAuditModuleEntry,
} from "../scripts/check-ui-audit-functional-report.js";

const modules: UiAuditModuleEntry[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "logs", label: "Logs" },
];

const cleanReport = (): UiAuditFunctionalReport => ({
  modulesTested: 2,
  network: { failureCount: 0, failures: [] },
  console: { count: 0, entries: [] },
  results: [
    { module: "dashboard", clickOk: true },
    { module: "logs", clickOk: true },
  ],
});

describe("validateFunctionalReport", () => {
  test("accepts a clean report that rendered every module", () => {
    expect(validateFunctionalReport(cleanReport(), modules)).toEqual([]);
  });

  test("rejects missing module coverage, failed nav, console errors, and failed requests", () => {
    const report = cleanReport();
    report.modulesTested = 1;
    report.results = [{ module: "dashboard", clickOk: false }];
    report.console = { count: 1, entries: [{ type: "error", text: "boom" }] };
    report.network = {
      failureCount: 1,
      failures: [{ method: "GET", url: "http://127.0.0.1/missing", status: 500 }],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([
      "expected 2 modules, report tested 1",
      "missing result for module logs",
      "module dashboard navigation reported clickOk=false",
      "renderer console captured 1 entrie(s)",
      "network captured 1 failed request(s)",
    ]);
  });

  test("rejects a failed request without an http status even when the aggregate count is zero", () => {
    const report = cleanReport();
    report.network = {
      failureCount: 0,
      requests: [{ failed: true }],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([
      "network captured 1 failed request(s)",
    ]);
  });

  test("rejects when only the aggregate network counter reports failure", () => {
    const report = cleanReport();
    report.network = {
      failureCount: 2,
      requests: [{ status: 200 }],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([
      "network captured 2 failed request(s)",
    ]);
  });

  test("ignores Electron's own dev-mode security warning in the console gate", () => {
    const report = cleanReport();
    report.console = {
      dropped: 0,
      count: 1,
      entries: [
        {
          kind: "console",
          level: "warning",
          text: '%cElectron Security Warning (Insecure Content-Security-Policy) font-weight: bold; This renderer process has either no Content Security Policy set or a policy with "unsafe-eval" enabled. This warning will not show up once the app is packaged.',
        },
      ],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([]);
  });

  test("still counts real app console output alongside an Electron security warning", () => {
    const report = cleanReport();
    report.console = {
      dropped: 0,
      count: 2,
      entries: [
        {
          kind: "console",
          level: "warning",
          text: "Electron Security Warning (Insecure Content-Security-Policy)",
        },
        { kind: "console", level: "error", text: "TypeError: cannot read properties of undefined" },
      ],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([
      "renderer console captured 1 entrie(s)",
    ]);
  });
});
