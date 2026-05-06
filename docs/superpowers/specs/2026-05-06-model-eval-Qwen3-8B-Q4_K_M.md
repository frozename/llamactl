# Model Eval: Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf

## Identity
- GGUF: (remote: http://192.168.68.76:18182)
- File size: 0.00 GiB

## Hardware Matrix
| node | ub | throughput_tps | ttft_ms | composite | asof |
| --- | --- | --- | --- | --- | --- |
| mac-mini | 512 | 21.11 | 9475 | 0.711 | 2026-05-06T05:45:12.040Z |

## Sub-Bench Details
### Throughput
#### Throughput
- mean: 21.11 tps
- spread: slowest translation 20.71 tps, fastest explain_concept 21.32 tps
#### Tool-Calling
- score: 33.3%
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
- score: 100.0%
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
- score: 100.0%
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
- score: 100.0%
(no per-prompt details available — re-run to regenerate)

## Tuning Sweep
| ub | composite | throughput_tps |
| --- | --- | --- |
| 512 | 0.711 | 21.11 |

## Verdict
Best result is mac-mini ub 512 with composite 0.711. Solid agentic candidate — strong across throughput, context retrieval, JSON output.