import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSystemdUnit } from "../src/commands/agent-install/systemd-template.js";
import { runDoctor } from "../src/commands/doctor.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";

/**
 * `llamactl doctor [units]` — the #196 contract. The production seat
 * (strata under llamactl-controller.service) was OOM-killed because its
 * user units inherited OOMScoreAdjust=200 while co-located dev jobs ran
 * at 100. The probe must warn when an installed llamactl unit resolves
 * to an OOMScoreAdjust above 100 or unset, honour <unit>.d/*.conf
 * drop-ins in lexical order, ignore comments and non-[Service] sections,
 * and stay quiet under --skip=units and on non-Linux hosts. Fixtures are
 * plain files in a temp unit dir injected via DoctorDeps.units — no
 * systemd, no real home dir, no sleeps.
 */

const BARE = `[Unit]
Description=llamactl controller

[Service]
Type=simple
ExecStart=/opt/llamactl/bin/llamactl controller run
Restart=always
KillMode=process

[Install]
WantedBy=default.target
`;

function captureStdout<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);

  process.stdout.write = (s: string | Uint8Array): boolean => {
    chunks.push(typeof s === "string" ? s : String(s));
    return true;
  };
  return fn()
    .then((result) => ({ result, out: chunks.join("") }))
    .finally(() => {
      process.stdout.write = original;
    });
}

describe("doctor [units] probe (#196)", () => {
  let unitDir: string;

  beforeEach(() => {
    unitDir = mkdtempSync(join(tmpdir(), "doctor-units-"));
  });

  afterEach(() => {
    rmSync(unitDir, { force: true, recursive: true });
  });

  function writeUnit(name: string, content: string): void {
    writeFileSync(join(unitDir, name), content);
  }

  function writeDropIn(unit: string, file: string, content: string): void {
    const dropInDir = join(unitDir, `${unit}.d`);
    mkdirSync(dropInDir, { recursive: true });
    writeFileSync(join(dropInDir, file), content);
  }

  function runWithUnits(
    extraArgs: string[],
    platform: "linux" | "darwin" = "linux",
  ): Promise<{ result: number; out: string }> {
    return captureStdout(() =>
      runDoctor(
        ["--skip=agent", "--skip=docker", "--skip=kubernetes", "--skip=secrets", ...extraArgs],
        { units: { platform, unitDir } },
      ),
    );
  }

  test("warns when an installed controller unit sets no OOMScoreAdjust (#196)", async () => {
    writeUnit("llamactl-controller.service", BARE);

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(1);
    expect(out).toContain("[units]");
    expect(out).toContain("⚠");
    expect(out).toContain("llamactl-controller.service sets no OOMScoreAdjust");
    expect(out).toContain("llamactl-controller.service.d/oom.conf");
    expect(out).toContain("OOMScoreAdjust=100");
    expect(out).toContain("drop-ins under /etc/systemd/user and user.control are not read");
    expect(out).not.toContain("llamactl-agent.service");
  });

  test("accepts a drop-in that lowers the score to 100", async () => {
    writeUnit("llamactl-controller.service", BARE);
    writeDropIn("llamactl-controller.service", "oom.conf", "[Service]\nOOMScoreAdjust=100\n");

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(0);
    expect(out).toContain(
      "✓ llamactl-controller.service OOMScoreAdjust=100 (llamactl-controller.service.d/oom.conf)",
    );
    expect(out).not.toContain("keeps its own floor");
  });

  test("the lexically last drop-in wins", async () => {
    writeUnit("llamactl-controller.service", BARE);
    writeDropIn("llamactl-controller.service", "20-high.conf", "[Service]\nOOMScoreAdjust=300\n");
    writeDropIn("llamactl-controller.service", "10-low.conf", "[Service]\nOOMScoreAdjust=100\n");
    writeDropIn(
      "llamactl-controller.service",
      "99-ignored.conf.bak",
      "[Service]\nOOMScoreAdjust=0\n",
    );

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(1);
    expect(out).toContain(
      "llamactl-controller.service OOMScoreAdjust=300 (llamactl-controller.service.d/20-high.conf) is above 100",
    );
  });

  test("names the main unit when a later drop-in sets only Environment=", async () => {
    writeUnit(
      "llamactl-controller.service",
      BARE.replace("KillMode=process\n", "KillMode=process\nOOMScoreAdjust=100\n"),
    );
    writeDropIn("llamactl-controller.service", "env.conf", "[Service]\nEnvironment=FOO=bar\n");

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(0);
    expect(out).toContain(
      "✓ llamactl-controller.service OOMScoreAdjust=100 (llamactl-controller.service)",
    );
    expect(out).not.toContain("(llamactl-controller.service.d/env.conf)");
  });

  test("names the drop-in that set the value, not a later drop-in that sets nothing", async () => {
    writeUnit("llamactl-controller.service", BARE);
    writeDropIn("llamactl-controller.service", "10-oom.conf", "[Service]\nOOMScoreAdjust=300\n");
    writeDropIn("llamactl-controller.service", "20-env.conf", "[Service]\nEnvironment=FOO=bar\n");

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(1);
    expect(out).toContain(
      "llamactl-controller.service OOMScoreAdjust=300 (llamactl-controller.service.d/10-oom.conf) is above 100",
    );
    expect(out).not.toContain("20-env.conf");
  });

  test("accepts a leading '+' the way systemd does", async () => {
    writeUnit("llamactl-controller.service", BARE);
    writeDropIn("llamactl-controller.service", "oom.conf", "[Service]\nOOMScoreAdjust=+100\n");

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(0);
    expect(out).toContain(
      "✓ llamactl-controller.service OOMScoreAdjust=100 (llamactl-controller.service.d/oom.conf)",
    );
    expect(out).not.toContain("is not an integer");
  });

  test("the shipped user template passes", async () => {
    writeUnit(
      "llamactl-agent.service",
      buildSystemdUnit({
        scope: "user",
        execPath: "/opt/llamactl/bin/llamactl",
        args: ["agent", "serve"],
        env: {},
        envFiles: [],
      }),
    );

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(0);
    expect(out).toContain("✓ llamactl-agent.service OOMScoreAdjust=100 (llamactl-agent.service)");
  });

  test("comments and other sections do not count", async () => {
    const decoys = BARE.replace(
      "KillMode=process\n",
      "KillMode=process\n# OOMScoreAdjust=100\n;OOMScoreAdjust=100\n",
    ).replace("WantedBy=default.target\n", "WantedBy=default.target\nOOMScoreAdjust=100\n");
    writeUnit("llamactl-controller.service", decoys);

    const { result, out } = await runWithUnits([]);

    expect(result).toBe(1);
    expect(out).toContain("llamactl-controller.service sets no OOMScoreAdjust");
  });

  test("a negative score in a user drop-in passes, and an empty assignment resets", async () => {
    writeUnit("llamactl-controller.service", BARE);
    writeDropIn("llamactl-controller.service", "oom.conf", "[Service]\nOOMScoreAdjust=-500\n");

    const lowered = await runWithUnits([]);

    expect(lowered.result).toBe(0);
    expect(lowered.out).toContain(
      "✓ llamactl-controller.service OOMScoreAdjust=-500 (llamactl-controller.service.d/oom.conf)",
    );
    expect(lowered.out).toContain("an unprivileged user manager keeps its own floor");

    writeUnit(
      "llamactl-controller.service",
      BARE.replace("KillMode=process\n", "KillMode=process\nOOMScoreAdjust=100\n"),
    );
    writeDropIn("llamactl-controller.service", "oom.conf", "[Service]\nOOMScoreAdjust=\n");

    const reset = await runWithUnits([]);

    expect(reset.result).toBe(1);
    expect(reset.out).toContain("llamactl-controller.service sets no OOMScoreAdjust");
  });

  test("--skip=units and non-Linux hosts suppress the probe", async () => {
    writeUnit("llamactl-controller.service", BARE);

    const linux = await runWithUnits([]);
    expect(linux.out).toContain("[units]");

    const skipped = await runWithUnits(["--skip=units"]);
    expect(skipped.out).not.toContain("[units]");
    expect(skipped.result).toBe(0);

    const darwin = await runWithUnits([], "darwin");
    expect(darwin.out).not.toContain("[units]");
    expect(darwin.result).toBe(0);
  });

  test("--help documents the [units] probe", async () => {
    const { result, out } = await captureStdout(() => runDoctor(["--help"]));

    expect(result).toBe(0);
    expect(out).toContain("[units]");
    expect(out).toContain("OOMScoreAdjust");
    expect(out).toContain("--skip=agent|docker|kubernetes|k8s|secrets|units");
  });
});
