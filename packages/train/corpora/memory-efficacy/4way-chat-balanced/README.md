Balanced sibling corpus for the 4-way memory-efficacy chat set.

Purpose: reduce the dominant `not_memory_related` class so macro-F1 is not
masked by the majority class on small splits.

Selection rule:
- Keep every minority row (`missed_registration`, `recall_miss`,
  `memory_ignored`).
- Sort `not_memory_related` rows by SHA1 of the first user message
  (`messages[0].content`), then take the first N rows for each split.

Exact counts:
- train: missed_registration=26, recall_miss=26, memory_ignored=28,
  not_memory_related=84
- valid: missed_registration=5, recall_miss=5, memory_ignored=3,
  not_memory_related=15
- test: missed_registration=4, recall_miss=4, memory_ignored=4,
  not_memory_related=12

Regenerate:
`python3 packages/train/corpora/memory-efficacy/build_balanced.py`

