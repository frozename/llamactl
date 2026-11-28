import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: eval perf macOS SSD I/O via proc_pid_rusage. Source pins
// run before doc pins so an implementation mutant surfaces its own needle;
// the proc_pid_rusage implementation and the new doc text do not exist at
// base, so those pins fail by assertion.
describe("#521 eval perf darwin SSD I/O", () => {
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));
  const normaliseSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/normalise.ts"));
  const darwinRusageSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/darwin-rusage.ts"));
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const evidenceSec = flat(sectionBody(/^### Capturing evidence for an arm/) ?? "");
  const launchSec = flat(sectionBody(/^### Measured load with --launch/) ?? "");
  const failuresSec = flat(sectionBody(/^### Host reader failures for an arm/) ?? "");
  const srcNoIoReason =
    "per-process disk I/O counters are read from /proc/<pid>/io on Linux and proc_pid_rusage on macOS; no I/O reader on ${platform}";
  const docNoIoReason =
    "per-process disk I/O counters are read from /proc/<pid>/io on Linux and proc_pid_rusage on macOS; no I/O reader on <platform>";

  // Kills: keeping /proc as the only I/O source, leaving the stale
  //        'which this build does not read' reason, or hiding the rusage
  //        flavor constant outside readers.ts.
  test("P1 readers.ts names proc_pid_rusage, RUSAGE_INFO_V2 and the cross-platform reason", () => {
    expect(readersSrc).toContain("proc_pid_rusage");
    expect(readersSrc).toContain("RUSAGE_INFO_V2");
    expect(readersSrc).toContain(srcNoIoReason);
    expect(readersSrc).not.toContain("which this build does not read");
  });

  // Kills: decoding the wrong rusage struct fields.
  test("P2 normalise.ts pins the ri_diskio byte offsets", () => {
    expect(normaliseSrc).toContain("RI_DISKIO_BYTESREAD_OFFSET = 144");
    expect(normaliseSrc).toContain("RI_DISKIO_BYTESWRITTEN_OFFSET = 152");
  });

  // Kills: statically linking the FFI at module load, or loading a library
  //        other than libSystem.
  test("P3 darwin-rusage.ts lazily loads libSystem through bun:ffi", () => {
    expect(darwinRusageSrc).toContain("export function defaultProcPidRusage(");
    expect(darwinRusageSrc).toContain('"/usr/lib/libSystem.B.dylib"');
    expect(darwinRusageSrc).toContain('await import("bun:ffi")');
  });

  // Kills: eval perf constructing createPerfHostReaders without the CLI's
  //        procPidRusage test seam.
  test("P4 eval perf hostReaders forwards procPidRusage", () => {
    expect(enclosingBody(evalPerfSrc, "function hostReaders(")).toContain("procPidRusage");
  });

  // Kills: the doc omitting the macOS implementation contract, its field
  //        names, the lazy loader, or the reason shown on other platforms.
  test("P5 evidence docs pin the rusage symbols, offsets and platform reason", () => {
    expect(readersSrc).toContain(srcNoIoReason);
    for (const needle of [
      "`proc_pid_rusage`",
      "`RUSAGE_INFO_V2`",
      "`ri_diskio_bytesread`",
      "`ri_diskio_byteswritten`",
      "`defaultProcPidRusage`",
      "`packages/eval/src/perf/darwin-rusage.ts`",
      "GTT is Linux-only; on macOS it is recorded `unavailable` with a named reason",
      docNoIoReason,
    ]) {
      expect(evidenceSec, needle).toContain(needle);
    }
  });

  // Kills: documenting the stale Linux-only macOS SSD reason even though a
  //        launch must not sample counters across two different processes.
  test("P6 launch docs say macOS SSD I/O keeps LAUNCH_IO_REASON", () => {
    expect(doc).toContain("### Measured load with --launch");
    expect(launchSec).toContain("On macOS, SSD I/O records the same `LAUNCH_IO_REASON`");
    expect(launchSec).not.toContain("on macOS the Linux-only reasons apply.");
  });

  // Kills: the failure documentation treating a non-zero rc as a zero
  //        sample or omitting it from the reader-failure contract.
  test("P7 host reader failure docs name non-zero proc_pid_rusage returns", () => {
    expect(doc).toContain("### Host reader failures for an arm");
    expect(failuresSec).toContain("a non-zero `proc_pid_rusage` return");
  });
});
