# A.2 — Operator guidance for the existing per-buffer env knobs

**Status: closed without PR.**

`MLX_MAX_OPS_PER_BUFFER` and `MLX_MAX_MB_PER_BUFFER` already exist
upstream (`mlx/utils.h:154-164`, wired at `mlx/backend/metal/device.cpp:521-522`).
The original task spec was based on outdated information that assumed
these were hardcoded literals.

Architecture defaults set at `device.cpp:499-520`:
- Phone (`'p'`): ops=20, mb=40
- Base / Pro (`'g'`): ops=40, mb=40
- Max (`'s'`): ops=50, mb=50
- Ultra (`'d'`): ops=50, mb=50

Operator guidance: on M-series base GPUs under sustained multi-model
load, try `MLX_MAX_OPS_PER_BUFFER=20` to shrink Metal command-buffer
encoding work and reduce GPU watchdog risk. Combine with the
per-process isolation pattern (one oMLX per model) for best results.

No upstream PR needed. The existing operator guidance should be added
to MLX docs in a separate documentation-only PR if maintainers want it.
