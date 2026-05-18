export interface ModelSpec {
  name: string;
  gguf_path: string;
  quant: string;
  family: string;
  size_params: string;
  host: string;
  port: number;
  extra_args: string[];
  binary?: string;
  start_args?: string[];
  managed?: boolean;
  lora_path?: string;
  prompt_template?: 'chat-format' | 'bare-instruct' | 'bare-base';
  inference_toggles?: Record<string, unknown>;
}

export interface WorkloadEval {
  name: string;
  corpus_path: string;
  /**
   * Returns the body shape passed to llama-server: string for `/completion`,
   * `{messages: ...}` for `/chat/completions`. Concrete typing lands in v1.
   */
  prompt_builder: (row: unknown) => {
    messages: unknown[];
    tools?: unknown[];
    tool_choice?: unknown;
  };
  scorer: (
    row: unknown,
    completion: string,
    meta?: { tool_calls?: unknown[] },
  ) =>
    | { metrics: Record<string, number>; prediction: string; gold: string }
    | Promise<{ metrics: Record<string, number>; prediction: string; gold: string }>;
  framing?: string;
  primary_metric_name?: string;
  judge_model?: ModelSpec;
}

export interface CellRowDetail {
  run_id: string;
  model_name: string;
  workload_name: string;
  row_index: number;
  prediction: string | null;
  gold: string | null;
  metrics_json: string;
  latency_ms: number | null;
}

export interface CellRow {
  run_id: string;
  runner_version: number;
  model_name: string;
  workload_name: string;
  model_spec_json: string;
  n_rows: number;
  primary_metric_name: string;
  primary_metric_value: number;
  per_class_metrics_json: string;
  latency_p50_ms: number;
  latency_p95_ms: number;
  throughput_tps: number;
  errors: number;
  started_at: string;
  finished_at: string;
  host_machine: string;
}
