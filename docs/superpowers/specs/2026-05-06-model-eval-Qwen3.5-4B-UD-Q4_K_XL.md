# Model Eval: Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf

## Identity

- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf
- File size: 2.71 GiB

## Hardware Matrix

| node  | ub  | throughput_tps | ttft_ms | composite | asof                     |
| ----- | --- | -------------- | ------- | --------- | ------------------------ |
| local | 512 | 49.56          | 4038    | 0.875     | 2026-05-06T04:01:32.789Z |

## Sub-Bench Details

### Throughput

#### Throughput

- mean: 49.56 tps
- spread: slowest explain_concept 49.10 tps, fastest long_code_review 49.78 tps

#### Tool-Calling

- score: 58.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

### Tool-Calling

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 58.3%
- find_llama_bin_mtp: invalid JSON
- approve_handoff: invalid JSON
- start_chain: invalid JSON
- search_memory_project: invalid JSON
- approve_another_handoff: invalid JSON

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

### Context Retrieval

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 58.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

- 4k: 3/3 found
- 8k: 3/3 found
- 16k: 3/3 found

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

### JSON Output

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 58.3%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

## Tuning Sweep

| ub  | composite | throughput_tps |
| --- | --------- | -------------- |
| 512 | 0.875     | 49.56          |

## Verdict

Best result is local ub 512 with composite 0.875. Solid agentic candidate — strong across throughput, context retrieval, JSON output.
