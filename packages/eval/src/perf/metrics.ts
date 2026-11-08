export const PERF_SUITE_NAME = "perf";

export const PREFILL_SIZES = [4096, 16384, 32768, 65536] as const;

export const CONCURRENCY_LEVELS = [1, 2, 4] as const;

export const PERF_METRIC_NAMES = [
  "load_cold_ms",
  "load_warm_ms",
  "prefill_4k_tps",
  "prefill_16k_tps",
  "prefill_32k_tps",
  "prefill_64k_tps",
  "decode_tps",
  "ttft_ms",
  "spec_acceptance",
  "c1_tps",
  "c2_tps",
  "c4_tps",
  "ssd_read_bytes",
  "ssd_write_bytes",
  "peak_rss_bytes",
  "peak_gtt_bytes",
] as const;
