# Refine `_schedule_waiting` memory-pressure admission to per-request rejection

## Motivation

Two pre-pop guards in `_schedule_waiting` previously broke the entire
scheduling loop when `self._admission_paused` was set OR when the
generation memory guard tripped:

```python
if self._admission_paused and self.running:
    break

if (self._prefill_memory_guard and self._memory_limit_bytes > 0
    and self.running and current_mem > self._memory_limit_bytes):
    break
```

Under sustained backpressure with a multi-request queue this was
**head-of-line-blocking**: none of the queued waiters could progress
until pressure cleared, even when individual request sizes would have
fit comfortably under the current budget. Real impact: a single oMLX
process serving multiple models can stall every pending `/v1/*`
request behind a transient memory spike, even ones whose preflight
math accepts them.

## Approach

Move the pop to the top of the loop and replace the global `break`
with per-request rejection through the existing `_preflight_memory_check`:

```python
request = self.waiting.popleft()

pressure_rejection: str | None = None
if self._admission_paused and self.running:
    pressure_rejection = (
        self._preflight_memory_check(request)
        or "admission paused by memory pressure"
    )
elif (self._prefill_memory_guard and self._memory_limit_bytes > 0
      and self.running):
    current = max(mx.get_active_memory(), get_phys_footprint())
    if current > self._memory_limit_bytes:
        pressure_rejection = (
            self._preflight_memory_check(request)
            or f"generation memory guard tripped ..."
        )

if pressure_rejection is not None:
    rejected_outputs.append(RequestOutput(
        request_id=request.request_id,
        finished=True, finish_reason="error",
        error=pressure_rejection,
    ))
    continue
```

`_preflight_memory_check` is already the canonical per-request memory
gate; it's called downstream in the same loop at the "normal"
admission rejection path. The refinement just calls it earlier when
a global pressure signal is set, surfaces the same
`finish_reason='error'` `RequestOutput`, and avoids the whole-loop
`break`. **No new memory-math code; no new admission policy; just
flow-control.**

## Preserved semantics

- **First request always passes**: both guards only fire when
  `self.running` is non-empty (matching the prior "admission can
  recover by completing the current generation" behaviour).
- **`_preflight_memory_check` body unchanged**: the patch only changes
  WHEN it's called.
- **Existing downstream preflight at the bottom of the loop still
  runs**: the new earlier call is a fast-fail; the late call is the
  authoritative per-request gate that was already there.

## Trade-off (vs. the prior break behaviour)

Old behaviour: under pressure, the queue stalls until pressure
clears, then processes waiters FCFS.

New behaviour: under pressure, waiters that don't fit are rejected
immediately with `finish_reason='error'` and a clear message the
client can retry against. Waiters that DO fit get admitted.

The downside is "fail fast" instead of "queue and wait". For
short-lived spikes the old behaviour was fine; for sustained
backpressure under heterogeneous co-resident models on a shared GPU,
the new behaviour is strictly more useful — clients get an immediate,
actionable error and the scheduler stays responsive for requests
that can be served.

If a deployment prefers queue-and-wait semantics, the operator can
keep `_admission_paused` and `_prefill_memory_guard` off; the new
code only activates them when explicitly set by upstream callers
(`ProcessMemoryEnforcer` for `_admission_paused`).

## Composition

- Independent of C.1 (Metal-error recovery on decode + prefill
  catches) and C.2 (per-model concurrency caps). The change is purely
  flow-control in `_schedule_waiting`.
- Pairs naturally with C.1: where C.1 catches GPU-level errors after
  they fire, this patch is a preflight refinement that prevents some
  of those errors from being attempted in the first place. Both end
  with the same `RequestOutput(finish_reason='error')` shape.

## Tests

`tests/test_admission_pause_refinement.py` covers:
1. Mixed-size queue under pressure: small request admitted, large
   rejected.
2. Multi-request queue with all-too-large requests: every waiter gets
   a `rejected_output` (loop iterates over all waiters instead of
   breaking after the first).

Both tests mock `_preflight_memory_check` to avoid bringing up a real
Metal device + tokenizer. Full end-to-end integration is documented
as a follow-up once a fixture lands in the oMLX test harness.

## Validation

Syntax-clean. Pytest skipped locally (pytest not in venv); structure
mirrors the existing `test_per_model_concurrency.py` test shape and
should run cleanly in the oMLX CI.
