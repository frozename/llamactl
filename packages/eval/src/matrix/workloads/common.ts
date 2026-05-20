import type { ResponseFormat } from '../../client.js';
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
  /** when true, schema requires a "reason" string alongside the label field */
  requireReason?: boolean;
}

export function buildJsonClassifierWorkload(opts: JsonClassifierOpts): WorkloadEval {
  if (opts.validLabels && opts.validLabels.size === 0) {
    throw new Error('buildJsonClassifierWorkload: validLabels must contain at least one label');
  }
  const normalize = opts.normalizeLabel ?? ((v: unknown) => String(v));
  const accept = (label: string): boolean => !opts.validLabels || opts.validLabels.has(label);
  const requireReason = opts.requireReason === true;
  const labels = opts.validLabels ? Array.from(opts.validLabels) : undefined;
  const response_format: ResponseFormat | undefined = labels
    ? {
        type: 'json_schema',
        json_schema: {
          name: opts.name.replace(/[^a-zA-Z0-9_]/g, '_'),
          schema: {
            type: 'object',
            properties: {
              [opts.labelField]: { type: 'string', enum: labels },
              ...(requireReason ? { reason: { type: 'string' } } : {}),
            },
            required: requireReason ? [opts.labelField, 'reason'] : [opts.labelField],
            additionalProperties: false,
          },
        },
      }
    : undefined;
  function stripCodeFences(s: string): string {
    const m = s.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
    if (m) return m[1];
    return s;
  }
  function tryParseJson(s: string): Record<string, unknown> | null {
    const stripped = stripCodeFences(s);
    try {
      return JSON.parse(stripped) as Record<string, unknown>;
    } catch {}
    const m = stripped.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {}
    }
    return null;
  }
  function extract(content: string): string {
    const parsed = tryParseJson(content);
    if (!parsed || !(opts.labelField in parsed)) return 'parse_error';
    const raw = parsed[opts.labelField];
    if (raw === undefined || raw === null) return 'parse_error';
    const label = normalize(raw);
    return accept(label) ? label : 'parse_error';
  }
  return {
    name: opts.name,
    corpus_path: opts.corpus_path,
    primary_metric_name: 'macro_f1',
    ...(response_format ? { response_format } : {}),
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
