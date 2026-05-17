import type { CellRow } from './types.js';

export interface ReportOpts {
  runId?: string;
}

type Section = 'primary_metric' | 'latency_p50_ms' | 'latency_p95_ms' | 'throughput_tps' | 'errors';

function filteredCells(cells: CellRow[], opts: ReportOpts): CellRow[] {
  return opts.runId ? cells.filter((cell) => cell.run_id === opts.runId) : cells;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function latestCellByModelWorkload(cells: CellRow[]): Map<string, CellRow> {
  const map = new Map<string, CellRow>();
  for (const cell of cells) {
    const key = `${cell.model_name}\u0000${cell.workload_name}`;
    const existing = map.get(key);
    if (!existing || existing.finished_at < cell.finished_at) {
      map.set(key, cell);
    }
  }
  return map;
}

function fmtMetric(value: number): string {
  return value.toFixed(4);
}

function fmtMs(value: number): string {
  return value.toFixed(0);
}

function fmtTps(value: number): string {
  return value.toFixed(2);
}

function pivotValue(section: Section, cell?: CellRow): string {
  if (!cell) return '';
  switch (section) {
    case 'primary_metric':
      return fmtMetric(cell.primary_metric_value);
    case 'latency_p50_ms':
      return fmtMs(cell.latency_p50_ms);
    case 'latency_p95_ms':
      return fmtMs(cell.latency_p95_ms);
    case 'throughput_tps':
      return fmtTps(cell.throughput_tps);
    case 'errors':
      return String(cell.errors);
  }
}

function buildGrid(cells: CellRow[]): { models: string[]; workloads: string[]; lookup: Map<string, CellRow> } {
  const models = uniqueSorted(cells.map((cell) => cell.model_name));
  const workloads = uniqueSorted(cells.map((cell) => cell.workload_name));
  return { models, workloads, lookup: latestCellByModelWorkload(cells) };
}

function getPrimaryMetricName(cells: CellRow[]): string {
  const names = uniqueSorted(cells.map((cell) => cell.primary_metric_name));
  return names.length === 1 ? names[0] : 'mixed';
}

function renderWinnerList(workloads: string[], lookup: Map<string, CellRow>): string {
  const lines = workloads.map((workload) => {
    let winner: CellRow | undefined;
    for (const cell of lookup.values()) {
      if (cell.workload_name !== workload) continue;
      if (
        !winner ||
        cell.primary_metric_value > winner.primary_metric_value ||
        (cell.primary_metric_value === winner.primary_metric_value && cell.finished_at > winner.finished_at)
      ) {
        winner = cell;
      }
    }
    if (!winner) return `- ${workload}: -`;
    return `- ${workload}: **${winner.model_name}** (${fmtMetric(winner.primary_metric_value)})`;
  });
  return ['## Per-workload winner', '', ...lines, ''].join('\n');
}

export function renderMarkdownReport(cells: CellRow[], opts: ReportOpts = {}): string {
  const filtered = filteredCells(cells, opts);
  const { models, workloads, lookup } = buildGrid(filtered);
  const primaryMetricName = getPrimaryMetricName(filtered);
  const sectionRows = (section: Section, mapper: (cell?: CellRow) => string) =>
    models.map((model) => {
      const values = workloads.map((workload) => mapper(lookup.get(`${model}\u0000${workload}`)) || '-');
      return `| ${[model, ...values].join(' | ')} |`;
    });
  const sections: string[] = [
    '# Matrix report',
    '',
    `Run: ${opts.runId ?? 'all'}`,
    `Cells: ${filtered.length}`,
    '',
    `## Primary metric (${primaryMetricName})`,
    '',
    `| ${['Model', ...workloads].join(' | ')} |`,
    `| ${['--', ...workloads.map(() => '--')].join(' | ')} |`,
    ...sectionRows('primary_metric', (cell) => pivotValue('primary_metric', cell)),
    '',
    `## Latency (p50 / p95, ms)`,
    '',
    `| ${['Model', ...workloads].join(' | ')} |`,
    `| ${['--', ...workloads.map(() => '--')].join(' | ')} |`,
    ...models.map((model) => {
      const values = workloads.map((workload) => {
        const cell = lookup.get(`${model}\u0000${workload}`);
        return cell ? `${fmtMs(cell.latency_p50_ms)} / ${fmtMs(cell.latency_p95_ms)}` : '-';
      });
      return `| ${[model, ...values].join(' | ')} |`;
    }),
    '',
    `## Throughput (tps)`,
    '',
    `| ${['Model', ...workloads].join(' | ')} |`,
    `| ${['--', ...workloads.map(() => '--')].join(' | ')} |`,
    ...models.map((model) => {
      const values = workloads.map((workload) => {
        const value = pivotValue('throughput_tps', lookup.get(`${model}\u0000${workload}`));
        return value || '-';
      });
      return `| ${[model, ...values].join(' | ')} |`;
    }),
    '',
    `## Errors`,
    '',
    `| ${['Model', ...workloads].join(' | ')} |`,
    `| ${['--', ...workloads.map(() => '--')].join(' | ')} |`,
    ...models.map((model) => {
      const values = workloads.map((workload) => {
        const cell = lookup.get(`${model}\u0000${workload}`);
        return cell ? String(cell.errors) : '-';
      });
      return `| ${[model, ...values].join(' | ')} |`;
    }),
    '',
    renderWinnerList(workloads, lookup),
  ];
  return sections.join('\n');
}

export function renderCsvReport(cells: CellRow[], opts: ReportOpts = {}): string {
  const filtered = filteredCells(cells, opts);
  const { models, workloads, lookup } = buildGrid(filtered);
  const sections: Array<[Section, (cell?: CellRow) => string]> = [
    ['primary_metric', (cell) => (cell ? fmtMetric(cell.primary_metric_value) : '')],
    ['latency_p50_ms', (cell) => (cell ? fmtMs(cell.latency_p50_ms) : '')],
    ['latency_p95_ms', (cell) => (cell ? fmtMs(cell.latency_p95_ms) : '')],
    ['throughput_tps', (cell) => (cell ? fmtTps(cell.throughput_tps) : '')],
    ['errors', (cell) => (cell ? String(cell.errors) : '')],
  ];
  const lines = ['section,model,workload,value'];
  for (const [section, formatter] of sections) {
    for (const model of models) {
      for (const workload of workloads) {
        const cell = lookup.get(`${model}\u0000${workload}`);
        lines.push([section, model, workload, formatter(cell)].join(','));
      }
    }
  }
  return lines.join('\n');
}
