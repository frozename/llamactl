import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { doc, enclosingBody, flat, readOrEmpty, REPO, sectionBody } from "./helpers.js";

// Part of #521: eval perf --launch peak-RSS and SSD-I/O reasons slice.
// Source pins run before doc pins so a source mutant surfaces its own
// needle; LAUNCH_IO_REASON and the new doc text do not exist at base, so
// those pins fail by assertion.
describe("#521 eval perf launch peak RSS", () => {
  const evalPerfSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf.ts"));
  const launchSrc = readOrEmpty(join(REPO, "packages/cli/src/commands/eval-perf-launch.ts"));
  const readersSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/readers.ts"));
  const runnerSrc = readOrEmpty(join(REPO, "packages/eval/src/perf/runner.ts"));
  const sec = flat(sectionBody(/^### Measured load with --launch/) ?? "");

  const launchIoReason =
    "--launch relaunches the engine between the cold and warm load, so no single engine process spans the suite; per-process SSD I/O (/proc/<pid>/io) is not measured";
  const missingPidReason = "peak-RSS reader failed: engine PID not known when the reader ran";

  // Kills: rewording the launch-specific SSD-I/O reason, or keeping it
  //        inline where the doc cannot cite a stable constant.
  test("source pins LAUNCH_IO_REASON byte-for-byte", () => {
    expect(launchSrc).toContain("export const LAUNCH_IO_REASON =");
    expect(launchSrc).toContain(launchIoReason);
  });

  // Kills: resolving the launched engine pid once before the suite starts,
  //        which would capture no process or the cold boot rather than the
  //        warm relaunch serving during the memory phase.
  test("source pins a live pid getter on the launch hooks", () => {
    const body = enclosingBody(launchSrc, "export function createLaunchLoadHooks(");
    expect(body).toContain("pid: () =>");
  });

  // Kills: turning a missing live pid into a null sample, which the runner
  //        would misreport as 'reader returned no sample', dropping the
  //        runner's reader-throw prefix, or dropping the /proc VmHWM path
  //        while adding the getter.
  test("source pins live-pid reader failure propagation and the VmHWM path", () => {
    expect(readersSrc).toContain("engine PID not known when the reader ran");
    expect(readersSrc).toContain("/proc/${String(pid)}/status");
    expect(runnerSrc).toContain("peak-RSS reader failed: ${sample.message}");
  });

  // Kills: passing null as the launch pid, which leaves --launch runs with
  //        the engine-PID-unknown reason even though the warm relaunch pid
  //        is knowable by the memory phase.
  test("source pins runEvalPerf passing the launch pid getter", () => {
    const body = enclosingBody(evalPerfSrc, "export async function runEvalPerf(");
    expect(body).not.toContain("pidForRun(resolved, parsed.launch)");
  });

  // Kills: the doc drifting byte-for-byte from either user-visible stored
  //        reason.
  test("doc quotes the launch SSD-I/O and missing-pid peak-RSS reasons", () => {
    expect(doc).toContain("### Measured load with --launch");
    expect(sec).toContain(`\`${launchIoReason}\``);
    expect(sec).toContain(`\`${missingPidReason}\``);
  });

  // Kills: the doc describing peak RSS as a cold-boot measurement or
  //        omitting the Linux-only VmHWM source.
  test("doc pins warm-relaunch VmHWM semantics", () => {
    expect(sec).toContain("VmHWM");
    expect(sec).toContain("/proc/<pid>/status");
    expect(sec).toContain("warm relaunch");
  });

  // Kills: the doc losing attribution for the live pid getter and the
  //        reader factory, making the behavior impossible to trace.
  test("doc cites the launch hooks and host reader factory", () => {
    expect(sec).toContain("createLaunchLoadHooks");
    expect(sec).toContain("packages/cli/src/commands/eval-perf-launch.ts");
    expect(sec).toContain("createPerfHostReaders");
    expect(sec).toContain("packages/eval/src/perf/readers.ts");
  });
});
