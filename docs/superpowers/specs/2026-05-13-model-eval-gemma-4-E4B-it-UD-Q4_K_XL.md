# Model Eval: gemma-4-E4B-it-GGUF/gemma-4-E4B-it-UD-Q4_K_XL.gguf

## Identity
- GGUF: (remote: http://192.168.68.76:18182)
- File size: 0.00 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| mac-mini | 256 | 28.65 | 7029 | 0.767 | 2026-05-13T22:08:52.933Z |
| mac-mini | 512 | 27.74 | 7288 | 0.757 | 2026-05-06T05:23:50.268Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 28.65 tps
- spread: slowest long_code_review 28.56 tps, fastest creative_short 28.72 tps
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
| ub | composite | throughput_tps |
| --- | --- | --- |
| 256 | 0.767 | 28.65 |
| 512 | 0.757 | 27.74 |

## Verdict
Best result is mac-mini ub 256 with composite 0.767. Solid agentic candidate — strong across throughput, context retrieval, JSON output.