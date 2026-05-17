export interface ModelSpec {
  name: string;
  gguf_path: string;
  quant: string;
  family: string;
  size_params: string;
  host: string;
  port: number;
  extra_args: string[];
  lora_path?: string;
  prompt_template?: 'chat-format' | 'bare-instruct' | 'bare-base';
  inference_toggles?: Record<string, unknown>;
}

export interface WorkloadEval {
  name: string;
  corpus_path: string;
  prompt_builder: (row: unknown) => unknown;
  scorer: (
    row: unknown,
    completion: string,
  ) => { metrics: Record<string, number>; prediction: string };
  framing?: string;
  primary_metric_name?: string;
}

export interface CellRow {
  run_id: string;
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
