import type { WorkloadEval } from '../types.js';

interface CorpusRow {
  messages: Array<{ role: string; content: string }>;
}

const VALID_LABELS = new Set([
  'missed_registration',
  'recall_miss',
  'memory_ignored',
  'not_memory_related',
]);

export const memoryEfficacy4wayWorkload: WorkloadEval = {
  name: 'memory-efficacy-4way',
  corpus_path: 'packages/train/corpora/memory-efficacy/4way-chat/test.jsonl',
  primary_metric_name: 'macro_f1',
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return { messages: r.messages.slice(0, -1) };
  },
  scorer: (row, completion) => {
    let pred: string = 'parse_error';
    try {
      const parsed = JSON.parse(completion);
      if (typeof parsed.classification === 'string' && VALID_LABELS.has(parsed.classification)) {
        pred = parsed.classification;
      }
    } catch {}
    let gold: string = 'parse_error';
    try {
      const r = row as CorpusRow;
      const goldContent = r.messages[r.messages.length - 1]?.content ?? '';
      const goldParsed = JSON.parse(goldContent);
      if (typeof goldParsed.classification === 'string' && VALID_LABELS.has(goldParsed.classification)) {
        gold = goldParsed.classification;
      }
    } catch {}
    return { metrics: { correct: pred === gold ? 1 : 0 }, prediction: pred, gold };
  },
};
