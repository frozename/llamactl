# Model Eval: Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf

## Identity

- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3.6-35B-A3B-GGUF/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf
- File size: 20.61 GiB

## Hardware Matrix

| node  | ub  | throughput_tps | ttft_ms | composite | asof                     |
| ----- | --- | -------------- | ------- | --------- | ------------------------ |
| local | 512 | 45.62          | 4432    | 0.830     | 2026-05-06T04:31:40.415Z |

## Sub-Bench Details

### Throughput

#### Throughput

- mean: 45.62 tps
- spread: slowest summarize 45.46 tps, fastest translation 45.89 tps

#### Tool-Calling

- score: 50.0%
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

- score: 50.0%
- find_llama_bin_mtp: invalid JSON
- mtp_gate_criteria: invalid JSON
- approve_handoff: invalid JSON
- start_chain: invalid JSON
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

- score: 50.0%
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

- score: 50.0%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 80.0%
- recipe-extract: no JSON

## Tuning Sweep

| ub  | composite | throughput_tps |
| --- | --------- | -------------- |
| 512 | 0.830     | 45.62          |

## Verdict

Best result is local ub 512 with composite 0.830. Solid agentic candidate — strong across throughput, context retrieval, JSON output.
