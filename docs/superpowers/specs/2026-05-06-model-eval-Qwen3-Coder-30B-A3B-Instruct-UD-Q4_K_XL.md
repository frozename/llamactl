# Model Eval: Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf

## Identity
- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3-Coder-30B-A3B-Instruct-GGUF/Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL.gguf
- File size: 16.45 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| local | 512 | 67.22 | 2344 | 0.925 | 2026-05-06T05:00:52.791Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 67.22 tps
- spread: slowest summarize 45.52 tps, fastest translation 76.22 tps
#### Tool-Calling
- score: 75.0%
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
- score: 75.0%
- mtp_gate_criteria: invalid JSON
- task_status: invalid JSON
- brainstorm_no_tool: args mismatch
#### Context Retrieval
(no per-prompt details available — re-run to regenerate)
#### JSON Output
- score: 100.0%
(no per-prompt details available — re-run to regenerate)

### Context Retrieval
#### Throughput
(no per-prompt details available — re-run to regenerate)
#### Tool-Calling
- score: 75.0%
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
- score: 75.0%
(no per-prompt details available — re-run to regenerate)
#### Context Retrieval
(no per-prompt details available — re-run to regenerate)
#### JSON Output
- score: 100.0%
(no per-prompt details available — re-run to regenerate)

## Tuning Sweep
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.925 | 67.22 |

## Verdict
Best result is local ub 512 with composite 0.925. Solid agentic candidate — strong across throughput, tool-calling, context retrieval, JSON output.