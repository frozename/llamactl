import type { WorkloadEval } from '../types.js';

export interface ChatCorpusRow {
  messages: Array<{ role: string; content: string }>;
}

export interface JsonClassifierOpts {
  name: string;
  corpus_path: string;
  /** key inside the assistant JSON content holding the label, e.g. "classification" or "memory_related" */
  labelField: string;
  /** when provided, predictions/gold not in this set fall back to 'parse_error' */
  validLabels?: Set<string>;
  /** customize how a parsed value is normalized to a string label. Default: String(value). */
  normalizeLabel?: (value: unknown) => string;
}

export function buildJsonClassifierWorkload(opts: JsonClassifierOpts): WorkloadEval {
  const normalize = opts.normalizeLabel ?? ((v: unknown) => String(v));
  const accept = (label: string): boolean => !opts.validLabels || opts.validLabels.has(label);
  function extract(content: string): string {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      if (!(opts.labelField in parsed)) return 'parse_error';
      const raw = parsed[opts.labelField];
      if (raw === undefined || raw === null) return 'parse_error';
      const label = normalize(raw);
      return accept(label) ? label : 'parse_error';
    } catch {
      return 'parse_error';
    }
  }
  return {
    name: opts.name,
    corpus_path: opts.corpus_path,
    primary_metric_name: 'macro_f1',
    prompt_builder: (row) => {
      const r = row as ChatCorpusRow;
      return { messages: r.messages.slice(0, -1) };
    },
    scorer: (row, completion) => {
      const pred = extract(completion);
      const r = row as ChatCorpusRow;
      const goldContent = r.messages[r.messages.length - 1]?.content ?? '';
      const gold = extract(goldContent);
      return { metrics: { correct: pred === gold ? 1 : 0 }, prediction: pred, gold };
    },
  };
}
