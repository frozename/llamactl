import type { WorkloadEval } from '../types.js';

interface CorpusRow {
  messages: Array<{ role: string; content: string }>;
}

export const memoryEfficacyBinaryWorkload: WorkloadEval = {
  name: 'memory-efficacy-binary',
  corpus_path: 'packages/train/corpora/memory-efficacy/binary-chat/test.jsonl',
  primary_metric_name: 'macro_f1',
  prompt_builder: (row) => {
    const r = row as CorpusRow;
    return { messages: r.messages.slice(0, -1) };
  },
  scorer: (row, completion) => {
    let pred: string = 'parse_error';
    try {
      const parsed = JSON.parse(completion);
      if (typeof parsed.memory_related === 'boolean') pred = String(parsed.memory_related);
    } catch {}
    let gold: string = 'parse_error';
    try {
      const r = row as CorpusRow;
      const goldContent = r.messages[r.messages.length - 1]?.content ?? '';
      const goldParsed = JSON.parse(goldContent);
      if (typeof goldParsed.memory_related === 'boolean') gold = String(goldParsed.memory_related);
    } catch {}
    return { metrics: { correct: pred === gold ? 1 : 0 }, prediction: pred, gold };
  },
};
