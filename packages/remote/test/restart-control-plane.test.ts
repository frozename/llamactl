import { describe, expect, test } from "bun:test";

import {
  parseControlPlaneLabels,
  restartControlPlane,
  type SubprocessRunner,
} from "../src/infra/services.js";

const LAUNCHCTL_LIST = [
  "PID\tStatus\tLabel",
  "501\t0\tcom.llamactl.controller",
  "-\t0\tcom.llamactl.fleet-supervisor",
  "1234\t0\tcom.llamactl.internal-proxy",
  "1235\t0\tcom.llamactl.node-agent",
  "9000\t0\tcom.apple.foo",
  "-\t0\tcom.apple.bar",
].join("\n");

describe("parseControlPlaneLabels", () => {
  test("returns exactly the llamactl labels, sorted + deduped", () => {
    expect(parseControlPlaneLabels(LAUNCHCTL_LIST)).toEqual([
      "com.llamactl.controller",
      "com.llamactl.fleet-supervisor",
      "com.llamactl.internal-proxy",
      "com.llamactl.node-agent",
    ]);
  });

  test("empty input → []", () => {
    expect(parseControlPlaneLabels("")).toEqual([]);
  });

  test("dedupes a repeated label", () => {
    const stdout = [
      "PID\tStatus\tLabel",
      "1\t0\tcom.llamactl.controller",
      "2\t0\tcom.llamactl.controller",
      "3\t0\tcom.llamactl.fleet-supervisor",
    ].join("\n");
    expect(parseControlPlaneLabels(stdout)).toEqual([
      "com.llamactl.controller",
      "com.llamactl.fleet-supervisor",
    ]);
  });

  test("skips short rows and blank lines defensively", () => {
    const stdout = [
      "",
      "com.llamactl.too-few-cols",
      "\t",
      "1\t0\tcom.llamactl.controller",
      "",
    ].join("\n");
    expect(parseControlPlaneLabels(stdout)).toEqual(["com.llamactl.controller"]);
  });

  test("honors a custom prefix", () => {
    expect(parseControlPlaneLabels(LAUNCHCTL_LIST, "com.apple.")).toEqual([
      "com.apple.bar",
      "com.apple.foo",
    ]);
  });
});

describe("restartControlPlane", () => {
  test("discovers via launchctl list then kickstarts each label in order", async () => {
    const captured: string[][] = [];
    const runner: SubprocessRunner = async (cmd) => {
      await Promise.resolve();
      captured.push(cmd);
      if (cmd[1] === "list") return { code: 0, stdout: LAUNCHCTL_LIST, stderr: "" };
      // Simulate a non-zero exit for one of the services.
      if (cmd.join(" ").includes("com.llamactl.internal-proxy")) {
        return { code: 3, stdout: "", stderr: "Could not find service" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const result = await restartControlPlane({ host: "darwin", runner, uid: 501 });

    // (a) launchctl list runs first.
    expect(captured[0]).toEqual(["launchctl", "list"]);
    // (b) one kickstart -k gui/<uid>/<label> per discovered label, exact cmds.
    expect(captured.slice(1)).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/com.llamactl.controller"],
      ["launchctl", "kickstart", "-k", "gui/501/com.llamactl.fleet-supervisor"],
      ["launchctl", "kickstart", "-k", "gui/501/com.llamactl.internal-proxy"],
      ["launchctl", "kickstart", "-k", "gui/501/com.llamactl.node-agent"],
    ]);
    // (c) all outcomes collected, including the simulated failure.
    expect(result.host).toBe("darwin");
    expect(result.dryRun).toBe(false);
    expect(result.restarted).toEqual([
      { label: "com.llamactl.controller", code: 0, stdout: "", stderr: "" },
      { label: "com.llamactl.fleet-supervisor", code: 0, stdout: "", stderr: "" },
      {
        label: "com.llamactl.internal-proxy",
        code: 3,
        stdout: "",
        stderr: "Could not find service",
      },
      { label: "com.llamactl.node-agent", code: 0, stdout: "", stderr: "" },
    ]);
    // (d) did NOT abort after the failure — node-agent still kickstarted.
    expect(result.restarted.length).toBe(4);
  });

  test("dry-run lists labels via launchctl list but never kickstarts", async () => {
    const captured: string[][] = [];
    const runner: SubprocessRunner = async (cmd) => {
      await Promise.resolve();
      captured.push(cmd);
      return { code: 0, stdout: LAUNCHCTL_LIST, stderr: "" };
    };

    const result = await restartControlPlane({ host: "darwin", dryRun: true, runner });

    expect(captured).toEqual([["launchctl", "list"]]);
    expect(captured.some((c) => c.includes("kickstart"))).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.restarted.map((r) => r.label)).toEqual([
      "com.llamactl.controller",
      "com.llamactl.fleet-supervisor",
      "com.llamactl.internal-proxy",
      "com.llamactl.node-agent",
    ]);
  });

  test("the discovery runner's stdout drives label set", async () => {
    const runner: SubprocessRunner = async (cmd) => {
      await Promise.resolve();
      if (cmd[1] === "list") return { code: 0, stdout: LAUNCHCTL_LIST, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await restartControlPlane({ host: "darwin", runner, uid: 501 });
    expect(result.restarted.map((r) => r.label)).toEqual([
      "com.llamactl.controller",
      "com.llamactl.fleet-supervisor",
      "com.llamactl.internal-proxy",
      "com.llamactl.node-agent",
    ]);
  });

  test("non-darwin host is a no-op with skippedReason and no runner calls", async () => {
    let called = false;
    const runner: SubprocessRunner = async (cmd) => {
      await Promise.resolve();
      called = true;
      return { code: 0, stdout: cmd.join(" "), stderr: "" };
    };

    const result = await restartControlPlane({ host: "linux", runner });

    expect(called).toBe(false);
    expect(result.host).toBe("linux");
    expect(result.restarted).toEqual([]);
    expect(result.skippedReason).toContain("darwin-only");
  });
});
