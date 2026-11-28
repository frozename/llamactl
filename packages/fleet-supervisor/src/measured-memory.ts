import { llamactlHome } from "@llamactl/core/config/env";
import { calibrateMeasuredEnvelope, type MeasuredEnvelope } from "@llamactl/core/resources/memory";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

import { mkdirSync, readFileSync, writeFileSync } from "./safe-fs.js";

export interface MeasuredMemoryEntry {
  workloadName: string;
  measuredAt: string;
  rssMeanMb: number;
  rssPeakMb: number;
  sampleCount: number;
  engineKind: "llama.cpp" | "oMLX";
  binary: string;
}

export type MeasuredMemoryCache = Record<string, MeasuredMemoryEntry>;

export function measuredMemoryCachePath(): string {
  return (
    process.env["LLAMACTL_MEASURED_MEMORY_PATH"] ??
    `${process.env["HOME"] ?? "/tmp"}/.llamactl/measured-memory.json`
  );
}

/**
 * Returns { peakMb } for the given modelKey when a measured entry exists,
 * or null when the cache file is absent, the key is missing, or the file is
 * unreadable / invalid JSON.
 */
export function readMeasuredMemoryCache(modelKey: string): { peakMb: number } | null {
  try {
    const raw = readFileSync(measuredMemoryCachePath(), "utf8");
    const parsed = JSON.parse(raw) as MeasuredMemoryCache;
    const entry = parsed[modelKey];
    if (
      !entry ||
      typeof entry.rssPeakMb !== "number" ||
      !Number.isFinite(entry.rssPeakMb) ||
      entry.rssPeakMb < 0
    )
      return null;
    return { peakMb: entry.rssPeakMb };
  } catch {
    return null;
  }
}

/**
 * Merges a new entry into the cache file, creating it (and any parent
 * directories) if absent.
 */
export function writeMeasuredMemoryCache(modelKey: string, entry: MeasuredMemoryEntry): void {
  const path = measuredMemoryCachePath();
  let existing: MeasuredMemoryCache = {};
  try {
    existing = JSON.parse(readFileSync(path, "utf8")) as MeasuredMemoryCache;
  } catch {
    /* start fresh on missing / invalid */
  }
  const updated = { ...existing, [modelKey]: entry };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(updated, null, 2) + "\n", "utf8");
}

type KnownCalibration = Extract<MeasuredEnvelope, { known: true }>;
type CalibrationInput = Parameters<typeof calibrateMeasuredEnvelope>[0];
type CalibrationRow = Omit<KnownCalibration, "known" | "provenance" | "attribution">;
type CalibrationResult =
  | { ok: true; recorded: boolean; envelope: KnownCalibration }
  | { ok: false; reason: Extract<MeasuredEnvelope, { known: false }>["reason"] };

export function measuredCalibrationStorePath(env?: NodeJS.ProcessEnv): string {
  return join(llamactlHome(env), "measured-calibrations.sqlite");
}

const CALIBRATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS measured_calibrations (
    calibration_key TEXT PRIMARY KEY NOT NULL,
    measured_at_ms INTEGER NOT NULL CHECK(measured_at_ms >= 0),
    sample_count INTEGER NOT NULL CHECK(sample_count > 0),
    peak_bytes REAL NOT NULL CHECK(peak_bytes >= 0),
    overhead_bytes REAL NOT NULL CHECK(overhead_bytes >= 0),
    envelope_bytes REAL NOT NULL CHECK(envelope_bytes = peak_bytes + overhead_bytes)
  ) STRICT
`;

function samplesHaveTimestamps(input: CalibrationInput, nowMs: number): boolean {
  return input.samples
    .filter(
      (sample) =>
        sample.status === "ok" && sample.source.trim() !== "" && sample.processBytes !== null,
    )
    .every(
      ({ observedAtMs }) =>
        observedAtMs !== null &&
        Number.isSafeInteger(observedAtMs) &&
        observedAtMs >= 0 &&
        observedAtMs <= nowMs,
    );
}

export function recordMeasuredMemoryCalibration(
  input: CalibrationInput,
  path = measuredCalibrationStorePath(),
): CalibrationResult {
  const envelope = calibrateMeasuredEnvelope(input);
  if (!envelope.known) return { ok: false, reason: envelope.reason };
  if (!samplesHaveTimestamps(input, Date.now()) || !Number.isFinite(envelope.envelopeBytes)) {
    return { ok: false, reason: "invalid-input" };
  }

  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.run("PRAGMA busy_timeout = 5000");
    db.run(CALIBRATIONS_SCHEMA);
    const result = db.run(
      `INSERT INTO measured_calibrations VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(calibration_key) DO UPDATE SET
         measured_at_ms = excluded.measured_at_ms,
         sample_count = excluded.sample_count,
         peak_bytes = excluded.peak_bytes,
         overhead_bytes = excluded.overhead_bytes,
         envelope_bytes = excluded.envelope_bytes
       WHERE excluded.measured_at_ms > measured_calibrations.measured_at_ms
          OR (excluded.measured_at_ms = measured_calibrations.measured_at_ms
              AND excluded.envelope_bytes > measured_calibrations.envelope_bytes)`,
      [
        envelope.key,
        envelope.measuredAtMs,
        envelope.sampleCount,
        envelope.peakBytes,
        envelope.calibrationOverheadBytes,
        envelope.envelopeBytes,
      ],
    );
    return { ok: true, recorded: result.changes > 0, envelope };
  } finally {
    db.close();
  }
}

/** Preserve the distinction between a successful miss and a store read failure. */
export function readMeasuredMemoryCalibrationStrict(
  key: string,
  path: string,
): KnownCalibration | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query<CalibrationRow, [string]>(
        `SELECT calibration_key AS key, measured_at_ms AS measuredAtMs, sample_count AS sampleCount,
                peak_bytes AS peakBytes, overhead_bytes AS calibrationOverheadBytes,
                envelope_bytes AS envelopeBytes
         FROM measured_calibrations WHERE calibration_key = ?`,
      )
      .get(key);
    return row === null
      ? null
      : { ...row, known: true, provenance: "measured", attribution: "process" };
  } finally {
    db.close();
  }
}

export function readMeasuredMemoryCalibration(
  key: string,
  path = measuredCalibrationStorePath(),
): KnownCalibration | null {
  try {
    return readMeasuredMemoryCalibrationStrict(key, path);
  } catch {
    return null;
  }
}
