# Add per-model max-concurrent-requests overrides

## Motivation

oMLX currently exposes a single global `--max-concurrent-requests` setting.
That is workable for homogeneous workloads, but it forces mixed-model
servers to pick one compromise concurrency cap for every model. In the
common heterogeneous case, a small model can safely run at a higher
request concurrency than a larger model sharing the same GPU. Per-model
caps let the operator tune those limits independently without splitting
the deployment into multiple processes.

## API

- New scheduler setting: `per_model_max_concurrent: dict[str, int]`
- New CLI flag: `--per-model-max-concurrent qwen3-8b=4,granite-3b=8`
- Parsing rule: comma-separated `MODEL=LIMIT` entries, with whitespace
  trimmed around each entry
- Settings serialization: the override map round-trips through
  `to_dict()` / `from_dict()` and is populated from `apply_args()`

## Admission Semantics

The scheduler still uses the global `max_concurrent_requests` setting as
its default concurrency ceiling. When a waiting request is considered for
admission, the scheduler checks the running count for that request's
model:

1. If the model appears in `per_model_max_concurrent`, its override is
   used as the cap for that model.
2. If the model is not listed, the scheduler falls back to the global
   `max_concurrent_requests` limit.

This keeps the existing global behavior intact while allowing targeted
exceptions for specific models.

## Tests

- CLI parsing for the new comma-separated override syntax
- `SchedulerSettings` round-trip coverage through dict serialization
- Admission tests that confirm a capped model is blocked while an
  uncapped model still follows the global limit

## Compatibility

Purely additive. If the new field is unset, the scheduler behaves exactly
as it does today because it continues to rely on the global concurrency
cap. Existing configurations do not need to change.
