# Model Eval: gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf

## Identity

- GGUF: (remote: http://192.168.68.76:18182)
- File size: 0.00 GiB

## Hardware Matrix

| node     | ub  | throughput_tps | ttft_ms | composite | asof                     |
| -------- | --- | -------------- | ------- | --------- | ------------------------ |
| m4-pro   | mtp | 28.61          | 0       | 0.611     | 2026-05-13T18:46:59Z     |
| mac-mini | 256 | 28.64          | 7055    | 0.766     | 2026-05-06T06:23:35.771Z |
| mac-mini | 512 | 27.74          | 7288    | 0.757     | 2026-05-06T05:23:50.268Z |

## Sub-Bench Details

### Throughput

#### Throughput

- mean: 28.64 tps
- spread: slowest long_code_review 28.47 tps, fastest qa_factual 28.69 tps

#### Tool-Calling

- score: 33.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 80.0%
  (no per-prompt details available — re-run to regenerate)

### Tool-Calling

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 33.3%
- find_llama_bin_mtp: invalid JSON
- mtp_gate_criteria: invalid JSON
- approve_handoff: invalid JSON
- task_status: invalid JSON
- start_chain: invalid JSON
- search_docs: invalid JSON
- search_memory_project: invalid JSON
- approve_another_handoff: invalid JSON

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 80.0%
  (no per-prompt details available — re-run to regenerate)

### Context Retrieval

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 33.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

- 4k: 3/3 found
- 8k: 3/3 found
- 16k: 3/3 found

#### JSON Output

- score: 80.0%
  (no per-prompt details available — re-run to regenerate)

### JSON Output

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 33.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 80.0%
- recipe-extract: no JSON

## Tuning Sweep

| ub  | composite | throughput_tps |
| --- | --------- | -------------- |
| 256 | 0.766     | 28.64          |
| 512 | 0.757     | 27.74          |

## Verdict

Best result is mac-mini ub 256 with composite 0.766. Solid agentic candidate — strong across throughput, context retrieval, JSON output.

## 2026-05-13 M4 Pro re-eval

- Assistant head: `/Volumes/WorkSSD/ai-models/llama.cpp/models/gemma-4-E4B-it-assistant-GGUF/gemma-4-E4B-it-assistant.Q4_K_M.gguf`
- SHA256: `6c93075cefa2902887afd7e341b32f3710fb3ecc13e3d7f31b272927cb30dacd`
- Size: `78575008` bytes
- MTP bench artifact: `/Users/acordeiro/DevStorage/bench/maestro-pilot/20260513T184659Z-gemma4-e4b-mtp-baseline.json`
- Aggregate: `22/36` passed, `0.611` pass rate, `28.61` decode tps, `0.7846` draft accept rate
- Category pass rates: original `8/8`, routing `5/5`, arg_fidelity `3/3`, multiturn `3/3`, safety `3/4`, planning `0/2`, edge `0/2`, memory `0/3`, handoff_mgmt `0/3`, workflow_plan `0/3`
- Verdict: MTP active, but this run does not justify a `>= 1.10x` claim on its own because the within-machine vanilla control never became reachable on ports `18183`/`18184` even though the startup log reached `main: server is listening`
- Notes: `--swa-full` was required in the atomic-fork launch shape; `gemma4.context_length = 131072`
