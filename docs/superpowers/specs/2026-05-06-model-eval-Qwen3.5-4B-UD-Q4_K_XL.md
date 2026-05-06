# Model Eval: Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf

## Identity
- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/Qwen3.5-4B-GGUF/Qwen3.5-4B-UD-Q4_K_XL.gguf
- File size: 2.71 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| local | 512 | 49.42 | 4052 | 0.475 | 2026-05-06T03:14:56.488Z |

## Sub-Bench Details
### Throughput
- mean: 49.42 tps
(no per-prompt details available — re-run to regenerate)

### Tool-Calling
- score: 58.3%
(no per-prompt details available — re-run to regenerate)

### Context Retrieval
- 4k: 0/3 found
- 8k: 0/3 found
- 16k: 0/3 found

### JSON Output
- score: 0.0%
(no per-prompt details available — re-run to regenerate)

## Tuning Sweep
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.475 | 49.42 |

## Verdict
Best result is local ub 512 with composite 0.475. Mixed — strong at throughput, weak at tool-calling, context retrieval, JSON output. Use selectively.
