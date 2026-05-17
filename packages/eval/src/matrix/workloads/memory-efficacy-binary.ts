import { buildJsonClassifierWorkload } from './common.js';

export const memoryEfficacyBinaryWorkload = buildJsonClassifierWorkload({
  name: 'memory-efficacy-binary',
  corpus_path: 'packages/train/corpora/memory-efficacy/binary-chat/test.jsonl',
  labelField: 'memory_related',
  normalizeLabel: (v) => (typeof v === 'boolean' ? String(v) : 'parse_error'),
});
