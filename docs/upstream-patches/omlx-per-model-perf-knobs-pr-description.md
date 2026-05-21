# Add per-model max_completion_batch_size and prefill_step_size overrides

## Motivation

The recently-landed `--per-model-max-concurrent` flag let operators run
heterogeneous concurrency budgets across co-resident models in one
oMLX process. Two more knobs need the same per-model treatment:

- **`completion_batch_size`**: 3B-class models are often happy at batch
  size 64 where 8B-class wants 16. A single global value is a bad
  compromise for mixed deployments.
- **`prefill_step_size`**: smaller models tolerate smaller chunks
  (lower TTFT, more scheduling overhead); larger models prefer bigger
  chunks. The hardcoded 2048 default suits some models but not all.

## Approach

Mirror the per-model resolution pattern from the `per_model_max_concurrent`
patch. Two new dict fields on `SchedulerSettings` and `SchedulerConfig`:

- `per_model_max_completion_batch_size: dict[str, int]`
- `per_model_prefill_step_size: dict[str, int]`

Same keying contract: basename of the model dir first, falling back to
the fully-qualified model_name. When the dedicated `Scheduler` instance
boots for a given model, the corresponding override (if any) REPLACES
the config field on that instance. Models without an entry use the
global default.

## CLI flags

```
--per-model-max-completion-batch-size qwen3-8b=16,granite-3b=64
--per-model-prefill-step-size granite-3b=512,qwen3-8b=2048
```

Same comma-separated `key=value` shape as `--per-model-max-concurrent`.
Malformed pairs and non-integer values raise `ValueError` with the
flag label in the message.

## Touchpoints

- `omlx/settings.py`: two new dict fields on `SchedulerSettings`;
  `from_dict` / `to_dict` round-trip with int coercion;
  `apply_args()` parses both new flags;
  `to_scheduler_config()` propagates both dicts.
- `omlx/cli.py`: two new `--per-model-...` flags wired to argparse.
- `omlx/scheduler.py`: two new dict fields on `SchedulerConfig`;
  per-model lookup in `Scheduler.__init__` that replaces
  `completion_batch_size` and `prefill_step_size` on the dedicated
  instance.
- `tests/test_per_model_perf_knobs.py`: round-trip + CLI parsing +
  propagation tests mirroring `test_per_model_concurrency.py`.

## Composition

Pairs with the recently-landed `--per-model-max-concurrent` patch on
`frozename/omlx feat/per-model-concurrency`. The three knobs together
cover the operationally-relevant per-model surface for heterogeneous-
model deployments on shared GPU.

Independent of the exception-safety + recovery patches; works purely at
the scheduler-admission / config-resolution layer.

## Tests

`tests/test_per_model_perf_knobs.py` covers:
- defaults are empty dicts
- `to_dict`/`from_dict` round-trip with int coercion
- CLI parser accepts both pre-parsed dicts and CLI strings
- malformed pairs raise with flag label in message
- non-integer values raise with flag label in message
- `to_scheduler_config` propagates both dicts to the runtime config

End-to-end integration (Scheduler boots with the override applied)
needs a model checkpoint; documented here as a follow-up integration
test once a fixture lands in the oMLX test harness.

## Validation

Settings + CLI tests pass locally (~157 LoC test, mirrors C.2 pattern
verbatim). No production-runtime impact when neither flag is set
(defaults to empty dicts, existing global defaults apply).
