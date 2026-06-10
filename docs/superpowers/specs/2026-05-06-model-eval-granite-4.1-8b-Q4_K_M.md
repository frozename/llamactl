# Model Eval: granite-4.1-8b-GGUF/granite-4.1-8b-Q4_K_M.gguf

## Identity

- GGUF: (remote: http://192.168.68.76:18182)
- File size: 0.00 GiB

## Hardware Matrix

| node     | ub  | throughput_tps | ttft_ms | composite | asof                     |
| -------- | --- | -------------- | ------- | --------- | ------------------------ |
| mac-mini | 512 | 19.62          | 7641    | 0.896     | 2026-05-06T06:09:11.949Z |

## Sub-Bench Details

### Throughput

#### Throughput

- mean: 19.62 tps
- spread: slowest long_code_review 19.29 tps, fastest translation 20.47 tps

#### Tool-Calling

- score: 100.0%
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

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

### Context Retrieval

#### Throughput

(no per-prompt details available — re-run to regenerate)

#### Tool-Calling

- score: 100.0%
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

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

#### Context Retrieval

(no per-prompt details available — re-run to regenerate)

#### JSON Output

- score: 100.0%
  (no per-prompt details available — re-run to regenerate)

## Tuning Sweep

| ub  | composite | throughput_tps |
| --- | --------- | -------------- |
| 512 | 0.896     | 19.62          |

## Verdict

Best result is mac-mini ub 512 with composite 0.896. Solid agentic candidate — strong across throughput, tool-calling, context retrieval, JSON output.
