# Model Eval: Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf

## Identity
- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3.6-27B-GGUF/Qwen3.6-27B-Q4_K_M.gguf
- File size: 15.66 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| local | 512 | 11.77 | 17182 | 0.698 | 2026-05-06T04:51:18.846Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 11.77 tps
- spread: slowest stepwise_math 11.60 tps, fastest explain_concept 11.86 tps
#### Tool-Calling
- score: 66.7%
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
- score: 66.7%
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
- score: 66.7%
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
- score: 66.7%
(no per-prompt details available — re-run to regenerate)
#### Context Retrieval
(no per-prompt details available — re-run to regenerate)
#### JSON Output
- score: 80.0%
- recipe-extract: no JSON

## Tuning Sweep
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.698 | 11.77 |

## Verdict
Best result is local ub 512 with composite 0.698. Mixed — strong at tool-calling, context retrieval, JSON output, weak at none. Use selectively.