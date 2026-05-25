# oMLX Slot v2 — Full Round-trip Validation (2026-05-25)

Final canary run after the asyncio-import hotfix landed (`e4411ce2`).

## End-to-end success

```
1. POST /slots/0?action=save body={"model":"granite-4.1-3b-4bit","request_handle":"longprompt1","prompt_tokens":[...420 tokens]}
   → 200 {"n_saved":256,"filename":"longprompt1.kvslot","request_handle":"longprompt1"}

2. POST /slots/0?action=restore body={"model":"granite-4.1-3b-4bit","request_handle":"longprompt1"}
   → 200 {"n_restored":256,"restore_epoch":"d50c99468822468099785cd2acf19822"}

3. POST /v1/chat/completions body={
       "model":"granite-4.1-3b-4bit",
       "messages":[{"role":"user","content":"apple apple apple..."}],
       "max_tokens":8,
       "x_omlx_request_handle":"longprompt1",
       "x_omlx_restore_epoch":"d50c99468822468099785cd2acf19822"
     }
   → 200 {
       "choices":[...],
       "usage":{
         "prompt_tokens":409,
         "completion_tokens":8,
         "prompt_tokens_details":{"cached_tokens":256}    ← slot applied! prefill skipped 256 tokens
       }
     }

oMLX log:
   [slot_apply_success] model_id=granite-4.1-3b-4bit request_handle=longprompt1 
       restore_epoch=d50c99468822468099785cd2acf19822 n_tokens_applied=256
```

**Total time: 0.68s for an 8-token completion against a 409-token prompt** — cache restore directly reflected in the response usage AND surfaced in the structured log.

## Bugs found + fixed during this canary

1. **`NameError: name 'asyncio' is not defined`** at `scheduler.py:3489` — Phase 2 used `asyncio.new_event_loop()` but the module wasn't imported. Mock-heavy unit tests never caught it. Hotfix: `e4411ce2` adds `import asyncio` at the top.

2. **Generic 500 instead of structured 409 for SlotApply* errors** — v2.5a wrapped the 3 known exception classes but not the generic `NameError` that fired before any SlotApply* could even be raised. Per-handler exception envelope still needs broadening (P2 follow-up).

3. **Prefix cache miss for short prompts** — block size is 256 tokens; lookups are full-block only. Short prompts (<256) never produce cache hits even on identical replay. Workaround: use prompts ≥256 for canaries. Long-term: configurable block size (no CLI flag today). Diagnostic in commit history; fix queued as separate slice.

## Branch state

```
oMLX feat/slot-api-phase-a (not pushed):
  e4411ce2 fix(scheduler): add missing asyncio import — uncaught NameError at runtime
  7b319d58 v2.5b — prefix-cache extraction + prompt-prefix manifest guard
  d251036e v2.5a — atomic consume + explicit-handle + chat-completion 409 envelope
  fd7b11fc Phase 4a — observability + rollback drain
  f27f5cdc Phase 2  — one-shot bind + restore_epoch + admission apply
  e95d0b8d Phase 1a — request_handle field + capability bit
  b1e91d0c Phase v2.A — mlx_lm safetensors round-trip
  cbcd79ac Phase C — restore + minimal guard set
  946186fc Phase B fixups
  8ec57cb4 Phase B — slot save + state machine + atomic publish
  0943c0e9 Phase A — slot HTTP skeleton + capability + CLI
```

## Open follow-ups

- **v2.6a oMLX hardening** (still queued):
  - OneShotBindTable bounds + LRU eviction (P1 architect/security)
  - Filename↔handle bijective canonicalization for `.safetensors` (P1 data)
  - Synchronous `try_apply` (drop new_event_loop) — architect P1, now extra-relevant given the asyncio bug
  - Scheduler→server dependency injection (P1 architect)
  - Simplicity persona's 5 redundant log-shape test cuts
  - Broader chat-completion exception envelope (catches arbitrary apply-time runtime errors → 409 or 500-with-structured-envelope)

- **Configurable block size** — make prefix-cache useful for prompts <256 tokens. CLI flag + scheduler config.

- **Push decision** on the oMLX branch + llamactl main.

## Canary teardown

Workload `mlx-granite-3b-slot-canary-mac-mini` still running on mac-mini (manual pid 76781, port 8197). Slot file `longprompt1.kvslot` preserved at `/Volumes/AI-DATA/cache/omlx-slot-canary-slots/`. Keep up for v2.6a fix-then-retest cycles.
