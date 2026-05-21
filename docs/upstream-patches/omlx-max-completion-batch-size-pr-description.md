# Add `--max-completion-batch-size` to decouple HTTP-layer admission from batch fusion

## Motivation

HTTP admission and GPU batch fusion are different control points. The
current `max_concurrent_requests` setting answers “how many requests may
enter the scheduler,” but it does not let operators cap how many
sequences get fused into a single decode step. On small Apple Silicon
GPUs, that distinction matters because the Metal command-buffer watchdog
can be sensitive to decode fusion under multi-model load.

## Background

This change is part of the broader MLX investigation documented in
`mlx-explore/mlx#2670` and the accompanying oMLX upstream-improvements
plan. The important point for this PR is narrow: a lower completion
batch size is an orthogonal back-pressure knob, not a replacement for
request admission control.

## Change summary

- Add `max_completion_batch_size: int | None = None` to
  `SchedulerSettings`.
- Round-trip the field through `to_dict()` and `from_dict()`.
- Update `to_scheduler_config()` so `completion_batch_size` uses the new
  field when set, otherwise falls back to `max_concurrent_requests`.
- Add `--max-completion-batch-size` to the CLI and wire it through
  `apply_args()`.

The default behavior is preserved. If the new setting is unset, oMLX
keeps using `max_concurrent_requests` as the completion batch size.

## Tests

- Default field value is `None`.
- `to_scheduler_config()` falls back to `max_concurrent_requests` when
  the new field is unset.
- `to_scheduler_config()` uses the override when it is set.
- `to_dict()` / `from_dict()` preserve the value.
- The CLI flag updates `SchedulerSettings` through `apply_args()`.

## Compatibility note

`from_dict()` treats a missing `max_completion_batch_size` key as `None`,
so existing config files continue to load without migration work.
