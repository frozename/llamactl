import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: eval perf macOS peak RSS through proc_pid_rusage
// RUSAGE_INFO_V4. Source pins run before doc pins so an implementation
// mutant surfaces its own needle; the V4 symbols and doc text do not exist
// at base, so those pins fail by assertion.
describe("#521 eval perf darwin peak footprint", () => {
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));
  const normaliseSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/normalise.ts"));
  const evidenceSec = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");
  const launchSec = flat(sectionBody(/^### Measured load with --launch/) ?? "");
  const peakRssSentence =
    "On macOS with `--pid`, `proc_pid_rusage` with flavor `RUSAGE_INFO_V4` fills `ri_lifetime_max_phys_footprint`, and its value is the peak RSS (`createPerfHostReaders`, `packages/eval/src/perf/readers.ts`).";
  const gttSentence =
    "GTT is Linux-only; on macOS it is recorded `unavailable` with a named reason (`hostReaders`, `packages/cli/src/commands/eval-perf.ts`).";
  const launchSentence =
    "On macOS, SSD I/O records the same `LAUNCH_IO_REASON`, peak RSS is read through `proc_pid_rusage` for the warm relaunch PID, and GTT keeps its Linux-only reason.";

  // Kills: using the V2 struct size, decoding the current or interval
  //        footprint offsets, or hiding the lifetime-maximum decoder.
  test("D1 normalise.ts pins the RUSAGE_INFO_V4 lifetime footprint constants and decoder", () => {
    expect(normaliseSrc).toContain("export const RUSAGE_INFO_V4 = 4;");
    expect(normaliseSrc).toContain("export const RUSAGE_INFO_V4_SIZE = 296;");
    expect(normaliseSrc).toContain("export const RI_LIFETIME_MAX_PHYS_FOOTPRINT_OFFSET = 240;");
    expect(normaliseSrc).toContain("export function decodeRusageInfoV4LifetimeMaxFootprint(");
  });

  // Kills: building no darwin peakRss reader, or keeping duplicate copies of
  //        the other-platform reason after the darwin branch gains one.
  test("D2 createPerfHostReaders uses the V4 decoder exactly in the readers factory", () => {
    const body = enclosingBody(readersSrc, "export function createPerfHostReaders(");
    expect(body).toContain("RUSAGE_INFO_V4");
    expect(body).toContain("decodeRusageInfoV4LifetimeMaxFootprint(");
    const reason = "no peak-RSS reader on ${platform}";
    expect(readersSrc.split(reason).length - 1).toBe(1);
  });

  // Kills: the evidence doc omitting the macOS peak-RSS contract or keeping
  //        the stale claim that peak RSS is Linux-only on macOS.
  test("D3 evidence docs pin the macOS peak-RSS and GTT sentences", () => {
    expect(doc).toContain("### Capturing evidence for an arm");
    expect(evidenceSec).toContain(peakRssSentence);
    expect(evidenceSec).toContain(gttSentence);
    expect(evidenceSec).not.toContain("Peak RSS and GTT are Linux-only");
  });

  // Kills: the launch doc keeping the stale platform-reason claim even though
  //        the warm relaunch pid reaches the macOS peak-RSS reader.
  test("D4 launch docs pin macOS peak RSS from the warm relaunch", () => {
    expect(doc).toContain("### Measured load with --launch");
    expect(launchSec).toContain(launchSentence);
    expect(launchSec).not.toContain("peak RSS and GTT keep their Linux-only reasons");
  });
});
