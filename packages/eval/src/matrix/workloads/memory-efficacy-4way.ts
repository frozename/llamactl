import { buildJsonClassifierWorkload } from "./common.js";

const VALID_4WAY_LABELS = new Set([
  "missed_registration",
  "recall_miss",
  "memory_ignored",
  "not_memory_related",
]);

export const memoryEfficacy4wayWorkload = buildJsonClassifierWorkload({
  name: "memory-efficacy-4way",
  corpus_path: "packages/train/corpora/memory-efficacy/4way-chat-fewshot/test.jsonl",
  labelField: "classification",
  requireReason: true,
  validLabels: VALID_4WAY_LABELS,
  normalizeLabel: (v) => (typeof v === "string" ? v : "parse_error"),
});
