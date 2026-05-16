# adversarial-v0

Seed set for the tool-call grammar corpus focused on cases where base Qwen3 + `--jinja` is not enough.

Distribution:
- 5 multi-tool rows
- 5 name-collision rows
- 5 ambiguous-intent rows
- 10 schema-edge rows

Purpose:
- Stress sequential tool planning.
- Stress tool-name disambiguation.
- Stress tool-vs-chat judgment on fresh or authoritative facts.
- Stress schema forms that are likely to shake out grammar generation bugs.

How to extend:
- Add hand-written rows only.
- Keep `id` unique and monotonic.
- Keep tool schemas realistic: search, calendar, weather, file, HTTP, task, or repo APIs.
- Prefer rows where a careful model would choose exactly one tool path or no tool at all.

Known caveats:
- This set is intentionally small and adversarial, not representative.
- Some rows reuse current-date examples for concreteness; update timestamps if you extend the set later.
- The `assistant.tool_calls` blocks are target shapes for training and evaluation, not runtime transcripts.
