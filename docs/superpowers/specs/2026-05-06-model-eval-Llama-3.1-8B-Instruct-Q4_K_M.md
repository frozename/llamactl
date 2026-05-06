# Model Eval: Llama-3.1-8B-GGUF/Llama-3.1-8B-Instruct-Q4_K_M.gguf

## Identity
- GGUF: (remote: http://192.168.68.76:18182)
- File size: 0.00 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| mac-mini | 512 | 21.75 | 7091 | 0.793 | 2026-05-06T05:53:46.094Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 21.75 tps
- spread: slowest stepwise_math 21.51 tps, fastest creative_short 22.20 tps
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
- mtp_gate_criteria: wrong tool
- haiku_no_tool: args mismatch
- summarize_no_tool: args mismatch
- translate_no_tool: args mismatch
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
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.793 | 21.75 |

## Verdict
Best result is mac-mini ub 512 with composite 0.793. Solid agentic candidate — strong across throughput, context retrieval, JSON output.