import { expect, test } from "bun:test";

import { judgeGeneration } from "../../src/residency/generation-evidence.js";

test("no recorded generation → uncertain with reason 'no-recorded-generation'", () => {
  const result = judgeGeneration({
    recorded: undefined,
    pidFilePid: 100,
    observation: { pid: 100, alive: true },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-recorded-generation" });
});

test("no observation → uncertain with reason 'no-observation' (regardless of pidFilePid)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: undefined,
    observation: undefined,
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation" });
});

test("same pid, alive, matching startTimeMs → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: 100,
    observation: { pid: 100, alive: true, startTimeMs: 1000 },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, matching executable → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    pidFilePid: 100,
    observation: { pid: 100, alive: true, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, matching startTimeMs and executable → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
    pidFilePid: 100,
    observation: { pid: 100, alive: true, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, different startTimeMs → different-generation (pid reuse)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: 100,
    observation: { pid: 100, alive: true, startTimeMs: 2000 },
  });
  expect(result.kind).toBe("different-generation");
  expect(result).toMatchObject({ kind: "different-generation", reason: "pid-reused" });
});

test("same pid, alive, different executable → different-generation (pid reuse)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    pidFilePid: 100,
    observation: { pid: 100, alive: true, executable: "/usr/bin/other-server" },
  });
  expect(result.kind).toBe("different-generation");
  expect(result).toMatchObject({ kind: "different-generation", reason: "pid-reused" });
});

test("same pid, not alive, observation has startTimeMs → verified-absent", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: 100,
    observation: { pid: 100, alive: false, startTimeMs: 1000 },
  });
  expect(result.kind).toBe("verified-absent");
});

test("same pid, not alive, observation has executable → verified-absent", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    pidFilePid: 100,
    observation: { pid: 100, alive: false, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("verified-absent");
});

test("same pid, not alive, no identifying fields → uncertain (unidentified-absence)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100 },
    pidFilePid: 100,
    observation: { pid: 100, alive: false },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "unidentified-absence" });
});

test("pidFilePid undefined (vanished) with no observation → uncertain (no-observation)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: undefined,
    observation: undefined,
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation" });
});

test("pidFilePid differs from recorded.pid but recorded pid still alive → uncertain (no-observation-for-recorded-pid)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    pidFilePid: 200,
    observation: { pid: 200, alive: true },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation-for-recorded-pid" });
});

test("inputs are not mutated", () => {
  const recorded = { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" };
  const observation = { pid: 100, alive: true, startTimeMs: 1000, executable: "/usr/bin/llama-server" };
  const originalRecorded = JSON.stringify(recorded);
  const originalObservation = JSON.stringify(observation);

  judgeGeneration({ recorded, pidFilePid: 100, observation });

  expect(JSON.stringify(recorded)).toBe(originalRecorded);
  expect(JSON.stringify(observation)).toBe(originalObservation);
});
