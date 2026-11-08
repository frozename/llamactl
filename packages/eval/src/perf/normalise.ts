import type { MetricValue } from "../matrix/types.js";

export interface IoByteCounts {
  readBytes: number;
  writeBytes: number;
}

export interface PrefillRateFallback {
  promptTokens: number;
  ttftMs: number;
}

export function okMetric(value: number): MetricValue {
  return { value, status: "ok" };
}

export function unavailableMetric(reason: string): MetricValue {
  return { value: null, status: "unavailable", reason };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function positiveRate(value: number | null): number | null {
  return value !== null && value > 0 ? value : null;
}

export function normaliseAcceptance(payload: unknown): MetricValue {
  const root = asRecord(payload);
  const timings = asRecord(root?.["timings"]);
  const usage = asRecord(root?.["usage"]);
  const gufo = asRecord(usage?.["gufo"]);
  const kapitsa = asRecord(usage?.["kapitsa"]);

  // ASSUMPTION: the Gufo draft fields (usage.draft_tokens /
  // draft_tokens_accepted, also accepted under usage.gufo) are as
  // observed in the prior gufo-glm53-exp bench output — the shape is not
  // documented in-repo. ASSUMPTION: the Kapitsa shape
  // (usage.kapitsa.draft_tokens / draft_tokens_accepted) is assumed to
  // mirror the Gufo shape — also undocumented. Unknown shapes count as
  // unavailable.
  const sources: readonly (readonly [number | null, number | null])[] = [
    [finiteNumber(timings?.["draft_n"]), finiteNumber(timings?.["draft_n_accepted"])],
    [finiteNumber(usage?.["draft_tokens"]), finiteNumber(usage?.["draft_tokens_accepted"])],
    [finiteNumber(gufo?.["draft_tokens"]), finiteNumber(gufo?.["draft_tokens_accepted"])],
    [finiteNumber(kapitsa?.["draft_tokens"]), finiteNumber(kapitsa?.["draft_tokens_accepted"])],
  ];
  for (const [draft, accepted] of sources) {
    if (draft === null) continue;
    if (draft === 0) return unavailableMetric("no draft tokens proposed");
    if (accepted === null || draft < 0 || accepted < 0) continue;
    return okMetric(accepted / draft);
  }
  return unavailableMetric("engine reports no draft acceptance");
}

export function normaliseDecodeTps(payload: unknown): MetricValue {
  const root = asRecord(payload);
  const timings = asRecord(root?.["timings"]);
  const usage = asRecord(root?.["usage"]);
  const gufo = asRecord(usage?.["gufo"]);

  const predicted = positiveRate(finiteNumber(timings?.["predicted_per_second"]));
  if (predicted !== null) return okMetric(predicted);

  const perSecond = positiveRate(finiteNumber(usage?.["completion_tokens_per_second"]));
  if (perSecond !== null) return okMetric(perSecond);

  const completionTokens = finiteNumber(usage?.["completion_tokens"]);
  const decodeMs = finiteNumber(gufo?.["decode_ms"]);
  if (completionTokens !== null && completionTokens > 0 && decodeMs !== null && decodeMs > 0) {
    return okMetric(completionTokens / (decodeMs / 1000));
  }
  return unavailableMetric("engine reports no decode rate");
}

export function normalisePrefillTps(payload: unknown, fallback?: PrefillRateFallback): MetricValue {
  const root = asRecord(payload);
  const timings = asRecord(root?.["timings"]);
  const usage = asRecord(root?.["usage"]);
  const gufo = asRecord(usage?.["gufo"]);

  const promptPerSecond = positiveRate(finiteNumber(timings?.["prompt_per_second"]));
  if (promptPerSecond !== null) return okMetric(promptPerSecond);

  const usagePerSecond = positiveRate(finiteNumber(usage?.["prompt_tokens_per_second"]));
  if (usagePerSecond !== null) return okMetric(usagePerSecond);

  const promptTokens = finiteNumber(usage?.["prompt_tokens"]);
  const prefillMs = finiteNumber(gufo?.["prefill_ms"]);
  if (promptTokens !== null && promptTokens > 0 && prefillMs !== null && prefillMs > 0) {
    return okMetric(promptTokens / (prefillMs / 1000));
  }

  if (
    fallback !== undefined &&
    Number.isFinite(fallback.promptTokens) &&
    fallback.promptTokens > 0 &&
    Number.isFinite(fallback.ttftMs) &&
    fallback.ttftMs > 0
  ) {
    return okMetric(fallback.promptTokens / (fallback.ttftMs / 1000));
  }
  return unavailableMetric("engine reports no prefill rate");
}

export function parseProcIo(text: string): IoByteCounts | null {
  let readBytes: number | null = null;
  let writeBytes: number | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("read_bytes:")) {
      readBytes = parseByteCount(trimmed.slice("read_bytes:".length));
    } else if (trimmed.startsWith("write_bytes:")) {
      writeBytes = parseByteCount(trimmed.slice("write_bytes:".length));
    }
  }
  if (readBytes === null || writeBytes === null) return null;
  return { readBytes, writeBytes };
}

function parseByteCount(raw: string): number | null {
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function parseVmHwm(statusText: string): number | null {
  const match = /^VmHWM:\s*(\d+)\s*kB\s*$/m.exec(statusText);
  if (match === null) return null;
  const kb = Number(match[1]);
  if (!Number.isSafeInteger(kb) || kb < 0) return null;
  return kb * 1024;
}

export interface RusageIoInput {
  ri_diskio_bytesread: number;
  ri_diskio_byteswritten: number;
}

export function rusageIo(r: RusageIoInput): IoByteCounts | null {
  const readBytes = r.ri_diskio_bytesread;
  const writeBytes = r.ri_diskio_byteswritten;
  if (
    !Number.isFinite(readBytes) ||
    !Number.isFinite(writeBytes) ||
    readBytes < 0 ||
    writeBytes < 0
  ) {
    return null;
  }
  return { readBytes, writeBytes };
}
