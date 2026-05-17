import { buildJsonClassifierWorkload } from './common.js';

const VALID_4WAY_LABELS = new Set([
  'missed_registration',
  'recall_miss',
  'memory_ignored',
  'not_memory_related',
]);

export const memoryEfficacy4wayBalancedWorkload = buildJsonClassifierWorkload({
  name: 'memory-efficacy-4way-balanced',
  corpus_path: 'packages/train/corpora/memory-efficacy/4way-chat-balanced/test.jsonl',
  labelField: 'classification',
  validLabels: VALID_4WAY_LABELS,
  normalizeLabel: (v) => (typeof v === 'string' ? v : 'parse_error'),
});
