# Model Eval: gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf

## Identity
- GGUF: /Users/acordeiro/DevStorage/ai-models/llama.cpp/models/gemma-4-26B-A4B-it-GGUF/gemma-4-26B-A4B-it-UD-Q4_K_XL.gguf
- File size: 15.92 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| local | 512 | 51.77 | 3929 | 0.955 | 2026-05-06T04:05:49.017Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 51.77 tps
- spread: slowest code_python 50.41 tps, fastest creative_short 52.12 tps
#### Tool-Calling
- score: 91.7%
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
- score: 91.7%
- start_chain: invalid JSON
#### Context Retrieval
(no per-prompt details available — re-run to regenerate)
#### JSON Output
- score: 80.0%
(no per-prompt details available — re-run to regenerate)

### Context Retrieval
#### Throughput
(no per-prompt details available — re-run to regenerate)
#### Tool-Calling
- score: 91.7%
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
- score: 91.7%
(no per-prompt details available — re-run to regenerate)
#### Context Retrieval
(no per-prompt details available — re-run to regenerate)
#### JSON Output
- score: 80.0%
- recipe-extract: no JSON

## Tuning Sweep
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.955 | 51.77 |

## Verdict
Best result is local ub 512 with composite 0.955. Solid agentic candidate — strong across throughput, tool-calling, context retrieval, JSON output.