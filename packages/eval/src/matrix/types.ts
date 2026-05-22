import type { ResponseFormat } from '../client.js';

export interface ModelSpec {
  name: string;
  engine?: 'llamacpp' | 'omlx';
  gguf_path: string;
  mlx_model_dir?: string;
  quant: string;
  family: string;
  size_params: string;
  host: string;
  port: number;
  extra_args: string[];
  binary?: string;
  start_args?: string[];
  managed?: boolean;
  /** Override the OpenAI request body's `model` field. Llama-server
   *  uses --alias local by default, so leaving this unset is correct
   *  for llama.cpp. For oMLX (multi-model), set to the directory
   *  basename (e.g. 'Qwen3-8B-MLX-4bit'). */
  request_model_id?: string;
  /** Send `chat_template_kwargs.enable_thinking: false` in every
   *  request body. Needed when a thinking-mode-capable model (Qwen3)
   *  is hosted by an engine that doesn't expose --reasoning off
   *  (oMLX); without this the model emits chain-of-thought that
   *  breaks structured-output scorers. */
  disable_thinking?: boolean;
  lora_path?: string;
  prompt_template?: 'chat-format' | 'bare-instruct' | 'bare-base';
  inference_toggles?: Record<string, unknown>;
  /**
   * Optional dflash block forwarded to oMLX prepareLaunch via
   * hostedModels[0].dflash. Shape validated by ModelHostHostedModelSchema
   * in packages/remote/src/workload/modelhost-schema.ts. Pass the full
   * { enabled, dflash_enabled, dflash_draft_model, ... } object.
   */
  dflash?: Record<string, unknown>;
  /** Default is supported; set false to opt out from forwarding response_format for this model. */
  structured_outputs_supported?: boolean;
}

export interface WorkloadEval {
  name: string;
  corpus_path: string;
  response_format?: ResponseFormat;
  /** Override the default max_tokens (256) for this workload. Set higher for long-gen workloads. */
  maxTokens?: number;
  /** Override the default temperature (0) for this workload. */
  temperature?: number;
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
