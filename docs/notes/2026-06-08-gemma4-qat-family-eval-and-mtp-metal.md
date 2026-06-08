# Gemma 4 QAT family — MMLU-Pro quality + MTP draft-spec on M4 Pro/Metal (2026-06-08)

Two investigations on the M4 Pro (Metal):
1. **Quality** — evaluate the rest of the Gemma 4 QAT family (E2B/E4B/12B/31B, plus
   the 26B-A4B already in the fleet) on the `reasoning-mc` MMLU-Pro suite.
2. **Speed** — fact-check a viral r/LocalLLaMA claim that Gemma 4 QAT + MTP
   speculative decoding gives 1.2–1.8× throughput. Verdict: real on CUDA, **does
   not transfer to Metal**.

## 1. MMLU-Pro quality (reasoning-mc @ 1024-tok output)

Served via the matrix harness; **mxfp4 MLX (oMLX)** for E4B/12B/26B/31B,
**q4_0 GGUF (llama.cpp)** for E2B (its MLX QAT repo is a stub — only `.gitattributes`).
150 rows/model (31B stopped at 113 — score already settled), 0 errors, exact-match.

| Model | Format | MMLU-Pro | no-answer |
|-------|--------|---------:|----------:|
| 31B   | mxfp4 MLX | **0.858** (n=113) | 1% |
| 12B   | mxfp4 MLX | **0.780** | 6% |
| 26B-A4B | mxfp4 MLX | 0.773 | 7% |
| E4B   | mxfp4 MLX | 0.680 | 9% |
| E2B   | q4_0 GGUF | 0.447 | 20% |

Takeaways:
- **12B is the efficiency sweet spot** — the dense 12B matches the 26B-A4B MoE
  (0.780 vs 0.773) at roughly half the footprint.
- **31B** is the clear quality leader (0.858).
- **All Gemma 12B+ QAT beat Qwen3.5-9B** (which scored 0.727–0.747 MMLU-Pro @1024
  in the prior MoQ-vs-UD run) — Gemma 4 QAT is genuinely strong on hard reasoning.
- **E2B** trails hard and has a 20% no-answer rate; it is also the only q4_0, so do
  not read its number as a clean size comparison against the mxfp4 models.

Model source: `mlx-community/gemma-4-{E4B,12B,26B-A4B,31B}-it-qat-mxfp4`,
`google/gemma-4-E2B-it-qat-q4_0-gguf`. Results db:
`packages/eval/results/gemma-qat-family-mmlu-2026-06-08.db` (untracked).

## 2. MTP draft-spec: CUDA claims vs Metal reality

Source: r/LocalLLaMA post (u/LeatherRub7248), **RTX 3090 / CUDA 13.2 / Ubuntu**.
Config: llama.cpp speculative decoding with a dedicated MTP-trained draft —
`-m <main qat-UD-Q4_K_XL> --model-draft <qat-assistant-MTP-Q8_0> --spec-type
draft-mtp --spec-draft-n-max 4 --spec-draft-ngl all`, q8_0 KV, ctx 40960,
temp 1.0 / top-p 0.95 / top-k 64, OSL 192, parallel 1.

Reproduced with the **exact** config on this M4 Pro/Metal:

| Model | Metal base | Metal MTP | **Metal speedup** | Metal accept | | CUDA claim | CUDA accept |
|-------|-----------:|----------:|------------------:|-------------:|-|-----------:|------------:|
| 12B   | 28.4 | 28.1 | **0.99× (flat)** | 0.850 | | 1.64× | 0.562 |
| 26B-A4B | 65.6 | 72.2 | **1.10× (marginal)** | 0.835 | | 1.18× | 0.518 |
| 31B   | 12.3 | 7.3  | **0.59× (−41%)** | 0.524 | | 1.83× | 0.526 |

Verdict: **the speedups are a CUDA phenomenon and do not transfer to Metal.**
- Draft *quality* transfers — Metal acceptance (0.84–0.85 for 12B/26B) is even
  higher than the CUDA post's (0.52–0.56).
- But the *throughput win* evaporates: 12B flat, 26B-A4B marginal, and the 31B —
  the post's best case (1.83×) — **regresses 41%** (12.3 → 7.3 tok/s).
- Cause: Metal serializes the draft and target forward passes, so each speculative
  cycle pays for ~2 large-model passes; high acceptance cannot amortize it. This is
  the inverse of CUDA, where the slow compute-bound 31B benefits most. Consistent
  with this repo's prior "speculative decoding fleet-wide negative on Metal"
  finding (2026-05-14), now confirmed for the new Gemma4-MTP (#23398) path too.

Model source: `unsloth/gemma-4-{12B,26B-A4B,31B}-it-qat-GGUF` (UD-Q4_K_XL mains) +
`Janvitos/gemma-4-{…}-it-qat-assistant-MTP-Q8_0-GGUF` (drafts). Binary: unified
`/Volumes/WorkSSD/src/llama.cpp` (master) — has `llama : add Gemma4 MTP (#23398)`
merged plus `--spec-type draft-mtp` / `--spec-draft-n-max`.

Methodology caveat: a quick bench (1 prompt, best-of-2, batch 1) matching the
post's "quick numbers"; the direction (Metal ≪ CUDA, mostly no win) is robust, exact
ratios would firm up with multi-prompt averaging. High Metal 12B/26B acceptance is
likely prompt-dependent.

## Recommendation

- **Use the QAT models** — 12B mxfp4 is the value pick; 31B for max quality.
- **Do not adopt MTP draft-spec on this M4 Pro** — only the 26B-A4B MoE sees a small
  (1.10×) win; the flagship 31B case is a hard regression. MTP is a CUDA optimization.

## Reproduction

MMLU family eval (requires the MLX models symlinked into `$LLAMACTL_MODELS_DIR`):
```
bun packages/eval/src/matrix/cli.ts \
  --models packages/eval/specs/gemma4-qat-family-reasoning.json \
  --workloads reasoning-mmlu-pro --concurrency 2 \
  --out-db packages/eval/results/gemma-qat-family-mmlu.db --report both \
  --report-out packages/eval/results/gemma-qat-family-mmlu
```

MTP throughput bench: `tools/mtp-bench/bench-mtp.sh` (see its README).

## Ops notes

- The matrix omlx path drives MLX QAT eval: `LLAMACTL_MODELS_DIR=/Volumes/WorkSSD/ai-models/mlx`
  (a dir of symlinks → HF cache snapshots), `request_model_id` = the symlink name.
- `hf` and `omlx` (homebrew / venv python tools) fail under the harness background
  sandbox (exit 126/127); model downloads and the omlx/llama-server benches must run
  with the sandbox disabled.

Memory: `[[gemma4-qat-family-mmlu-and-mtp-metal-2026-06-08]]`.
