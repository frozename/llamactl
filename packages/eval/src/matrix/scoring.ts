export interface PerClassMetric {
  label: string;
  precision: number;
  recall: number;
  f1: number;
  tp: number;
  fp: number;
  fn: number;
}

export interface AggregateResult {
  macro_f1: number;
  per_class: PerClassMetric[];
}

export function aggregateMetrics(predictions: { pred: string; gold: string }[]): AggregateResult {
  const labels = [...new Set(predictions.flatMap((row) => [row.pred, row.gold]))].sort();
  const perClass = labels.map((label) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const row of predictions) {
      if (row.pred === label && row.gold === label) {
        tp += 1;
      } else if (row.pred === label && row.gold !== label) {
        fp += 1;
      } else if (row.pred !== label && row.gold === label) {
        fn += 1;
      }
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    return { label, precision, recall, f1, tp, fp, fn };
  });
  const macro_f1 =
    perClass.length > 0
      ? perClass.reduce((sum, metric) => sum + metric.f1, 0) / perClass.length
      : 0;
  return { macro_f1, per_class: perClass };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower] ?? 0;
  }
  const weight = index - lower;
  return (sorted[lower] ?? 0) * (1 - weight) + (sorted[upper] ?? 0) * weight;
}
