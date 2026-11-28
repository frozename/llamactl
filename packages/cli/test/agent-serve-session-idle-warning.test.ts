import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseServeFlags,
  type ServeFlags,
  type ServeWiring,
  validateServeWiring,
} from "../src/commands/agent.js";
import { mkdtempSync, rmSync } from "../src/safe-fs.js";

const LEASES_OFF =
  "warning: LLAMACTL_RESIDENCY_SESSION_IDLE_MS is set but LLAMACTL_RESIDENCY_LEASES is off; no session registry is installed, so bound sessions do not block unloads\n";
const INVALID =
  "warning: LLAMACTL_RESIDENCY_SESSION_IDLE_MS is not a positive integer of milliseconds; ignoring it, so no session registry is installed\n";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-serve-idle-warning-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function parseFlags(dir: string): ServeFlags {
  const parsed = parseServeFlags([`--dir=${dir}`]);
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

function expectValidWiring(wiring: ServeWiring | { error: string }): asserts wiring is ServeWiring {
  expect("error" in wiring).toBe(false);
  if ("error" in wiring) throw new Error("validateServeWiring returned an error");
}

function warningsFor(env: Record<string, string>): string[] {
  const parsed = parseFlags(freshDir());
  const warnings: string[] = [];
  const wiring = validateServeWiring(parsed, {
    env,
    warn: (message) => {
      warnings.push(message);
    },
  });
  expectValidWiring(wiring);
  expect(wiring.tunnelCentralOn).toBe(false);
  return warnings;
}

describe("agent serve session-idle config warnings (#520)", () => {
  test("R1: idle timeout with leases unset warns that sessions cannot block unloads", () => {
    expect(warningsFor({ LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000" })).toEqual([LEASES_OFF]);
  });

  test.each(["0", "false", "yes", "TRUE"] as const)(
    "R2: leases value %s still counts as off",
    (leases) => {
      expect(
        warningsFor({
          LLAMACTL_RESIDENCY_LEASES: leases,
          LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000",
        }),
      ).toEqual([LEASES_OFF]);
    },
  );

  test.each(["0", "-5", "1.5", "abc", "", " 60000", "1e3", "60000ms"] as const)(
    "R3: invalid idle timeout value %s warns once leases are on",
    (idleMs) => {
      expect(
        warningsFor({
          LLAMACTL_RESIDENCY_LEASES: "1",
          LLAMACTL_RESIDENCY_SESSION_IDLE_MS: idleMs,
        }),
      ).toEqual([INVALID]);
    },
  );

  test("R4: textual true enables leases for the invalid-value warning", () => {
    expect(
      warningsFor({
        LLAMACTL_RESIDENCY_LEASES: "true",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "abc",
      }),
    ).toEqual([INVALID]);
  });

  test("R5: leases-off precedence emits exactly one warning for an invalid value", () => {
    expect(
      warningsFor({
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "abc",
      }),
    ).toEqual([LEASES_OFF]);
  });

  test("G1: no residency session environment is quiet", () => {
    expect(warningsFor({})).toEqual([]);
  });

  test("G2: valid idle timeout with leases on is quiet", () => {
    expect(
      warningsFor({
        LLAMACTL_RESIDENCY_LEASES: "1",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000",
      }),
    ).toEqual([]);
  });

  test("G3: textual true leases without an idle timeout is quiet", () => {
    expect(warningsFor({ LLAMACTL_RESIDENCY_LEASES: "true" })).toEqual([]);
  });

  test("G4: invalid values are never echoed into warnings", () => {
    const secret = "s3cr3t-value-xyz";
    const warnings = warningsFor({
      LLAMACTL_RESIDENCY_LEASES: "1",
      LLAMACTL_RESIDENCY_SESSION_IDLE_MS: secret,
    });
    expect(warnings.some((warning) => warning.includes(secret))).toBe(false);
  });

  test("G5: session-idle warnings never fail wiring or enable the central tunnel", () => {
    const envs: Record<string, string>[] = [
      { LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000" },
      ...["0", "false", "yes", "TRUE"].map((leases) => ({
        LLAMACTL_RESIDENCY_LEASES: leases,
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000",
      })),
      ...["0", "-5", "1.5", "abc", "", " 60000", "1e3", "60000ms"].map((idleMs) => ({
        LLAMACTL_RESIDENCY_LEASES: "1",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: idleMs,
      })),
      {
        LLAMACTL_RESIDENCY_LEASES: "true",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "abc",
      },
      { LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "abc" },
      {},
      {
        LLAMACTL_RESIDENCY_LEASES: "1",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "60000",
      },
      { LLAMACTL_RESIDENCY_LEASES: "true" },
      {
        LLAMACTL_RESIDENCY_LEASES: "1",
        LLAMACTL_RESIDENCY_SESSION_IDLE_MS: "s3cr3t-value-xyz",
      },
    ];
    for (const env of envs) warningsFor(env);
    expect(envs).toHaveLength(19);
  });
});
