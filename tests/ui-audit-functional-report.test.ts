import { describe, expect, test } from 'bun:test';

import {
  validateFunctionalReport,
  type UiAuditFunctionalReport,
  type UiAuditModuleEntry,
} from '../scripts/check-ui-audit-functional-report.js';

const modules: UiAuditModuleEntry[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'logs', label: 'Logs' },
];

const cleanReport = (): UiAuditFunctionalReport => ({
  modulesTested: 2,
  network: { failureCount: 0, failures: [] },
  console: { count: 0, entries: [] },
  results: [
    { module: 'dashboard', clickOk: true },
    { module: 'logs', clickOk: true },
  ],
});

describe('validateFunctionalReport', () => {
  test('accepts a clean report that rendered every module', () => {
    expect(validateFunctionalReport(cleanReport(), modules)).toEqual([]);
  });

  test('rejects missing module coverage, failed nav, console errors, and failed requests', () => {
    const report = cleanReport();
    report.modulesTested = 1;
    report.results = [{ module: 'dashboard', clickOk: false }];
    report.console = { count: 1, entries: [{ type: 'error', text: 'boom' }] };
    report.network = {
      failureCount: 1,
      failures: [{ method: 'GET', url: 'http://127.0.0.1/missing', status: 500 }],
    };

    expect(validateFunctionalReport(report, modules)).toEqual([
      'expected 2 modules, report tested 1',
      'missing result for module logs',
      'module dashboard navigation reported clickOk=false',
      'renderer console captured 1 entrie(s)',
      'network captured 1 failed request(s)',
    ]);
  });
});
