# Gemma 4 26B-A4B spec-draft A/B — 2026-05-14

10 prompts × ~500 tok output via 2 concurrent slots, same prompts both runs.

| Config | Wall | Notes |
|---|---|---|
| Vanilla 26B-A4B (no draft) | **85.7s** | 4B active params, MoE |
| 26B-A4B + Gemma-3-4B drafter, spec-draft-n-max=8, p-min=0.6 | 232s | 50-55% draft acceptance steady |

Throughput regression: **-64% slower with draft** despite high acceptance.

## Why

Gemma 4 26B-A4B uses MoE routing with ~4B active parameters per token. The
Gemma-3-4B drafter has roughly the same per-token compute cost as a single
target forward pass. With 50% acceptance and the drafter doing 8 forward
passes per spec window, the total compute is *higher* than just running
the target directly.

Speculative decoding payoff requires: `draft_cost_per_token × n_draft × (1 + reject_overhead) < target_cost_per_token × n_accepted`. For MoE targets where active params ~ drafter size, the LHS easily exceeds the RHS.

## Comparison across this session's spec-draft experiments

| Test | Target | Drafter | Acceptance | Throughput delta |
|---|---|---|---|---|
| Granite 3B → 8B | 8B Q4_K_M (hybrid) | 3B Q4_K_M | 79-91% | -15% |
| Gemma 4B → 26B-A4B | 26B-A4B (MoE 4B active) | 3-4B dense | 50-55% | -64% |

Both negative, different root causes:
- Granite: hybrid Mamba/SSM state rollback cost
- Gemma 4: drafter compute ≥ target active-params compute

## Conclusion

Drop spec-draft as a throughput lever for both current production models. For future sessions: only consider spec-draft when target is dense AND drafter is 4-10× smaller in active params. None of the locally-deployed models fit that profile.
