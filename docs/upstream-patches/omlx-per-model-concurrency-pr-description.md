## Motivation

oMLX currently exposes one global `--max-concurrent-requests` setting.
That works for homogeneous deployments, but mixed-model servers often
need different concurrency budgets per model because GPU capacity is not
uniform across the fleet. A smaller model can usually tolerate higher
request concurrency than a larger one sharing the same machine.

## API shape

- New scheduler setting: `per_model_max_concurrent: dict[str, int]`
- New CLI flag: `--per-model-max-concurrent qwen3-8b=4,granite-3b=8`
- Parsing rule: comma-separated `MODEL=LIMIT` entries, with whitespace
  trimmed around each pair
- Serialization rule: `to_dict()` / `from_dict()` round-trip the map
- CLI wiring rule: `apply_args()` copies the parsed dict into settings

## Admission semantics

The scheduler keeps the current global concurrency limit as the default
gate. When a waiting request is considered for admission, the scheduler
counts how many running requests belong to that same model:

1. If the model appears in `per_model_max_concurrent`, that value is the
   cap for the model.
2. If the model is absent, the scheduler falls back to the global
   `max_concurrent_requests` limit.

This means per-model caps only narrow or widen admission for the model
named in the override map. They do not change the rest of scheduler
policy.

## Tests

- CLI parsing of `--per-model-max-concurrent`
- Error handling for malformed `MODEL=LIMIT` input
- `SchedulerSettings` round-trip coverage through dict serialization
- Admission coverage that blocks a capped model even when global slots
  are still available

## Compatibility

Purely additive. When the new field is unset, behavior is identical to
today because the scheduler keeps using the global concurrency cap for
every model.
