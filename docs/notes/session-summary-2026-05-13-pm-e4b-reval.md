# Session summary — 2026-05-13 pm E4B re-eval

Project: `llamactl`. Session started: `2026-05-13T18:44:00Z`.

## What changed

- Downloaded the Gemma 4 E4B assistant head into the production model store:
  - `/Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-E4B-it-assistant-GGUF/gemma-4-E4B-it-assistant.Q4_K_M.gguf`
  - SHA256: `6c93075cefa2902887afd7e341b32f3710fb3ecc13e3d7f31b272927cb30dacd`
  - Size: `78575008` bytes
- Launched an atomic-fork `llama-server` on `:18181` with the corrected SWA/MTP shape and confirmed:
  - `main: server is listening on http://127.0.0.1:18181`
  - `srv    load_model: MTP assistant path ... loaded into target model`
  - `llama_kv_cache_iswa: using full-size SWA KV cache`
- Ran `tools/maestro-bench/bench-maestro.py` against the MTP server.

## Phase 1 result

- Artifact: `/Users/acordeiro/DevStorage/bench/maestro-pilot/20260513T184659Z-gemma4-e4b-mtp-baseline.json`
- Aggregate: `22/36` passed
- Pass rate: `0.611`
- Decode tps: `28.61`
- Draft accept rate: `0.7846`
- Category pass rates:
  - original `8/8`
  - routing `5/5`
  - arg_fidelity `3/3`
  - multiturn `3/3`
  - safety `3/4`
  - planning `0/2`
  - edge `0/2`
  - memory `0/3`
  - handoff_mgmt `0/3`
  - workflow_plan `0/3`

## Control attempt

- I attempted a vanilla within-machine control on `:18183` and `:18184` with the same base model and cache settings.
- The startup log reached `main: server is listening`, but `curl http://127.0.0.1:<port>/health` never became reachable from the local shell.
- Because of that, I did not record a valid within-machine control benchmark and did not claim a `>= 1.10x` MTP win.

## Notes

- The live 26B server args on `:8181` showed the atomic-fork shape with `--swa-full`, `--cache-reuse 256`, and the MTP head wiring.
- The E4B base model reports `gemma4.context_length = 131072`, so `--ctx-size 32768` was valid.
- The temporary benchmark servers on `:18181`, `:18183`, and `:18184` were torn down after the run.
