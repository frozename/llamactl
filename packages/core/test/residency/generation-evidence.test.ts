import { expect, test } from "bun:test";

import { judgeGeneration } from "../../src/residency/generation-evidence.js";

test("no recorded generation → uncertain with reason 'no-recorded-generation'", () => {
  const result = judgeGeneration({
    recorded: undefined,
    observation: { pid: 100, alive: true },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-recorded-generation" });
});

test("no observation → uncertain with reason 'no-observation'", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: undefined,
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation" });
});

test("same pid, alive, matching startTimeMs → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: true, startTimeMs: 1000 },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, matching executable → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: true, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, matching startTimeMs and executable → same-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: true, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("same-generation");
});

test("same pid, alive, different startTimeMs → different-generation (pid reuse)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: true, startTimeMs: 2000 },
  });
  expect(result.kind).toBe("different-generation");
  expect(result).toMatchObject({ kind: "different-generation", reason: "pid-reused" });
});

test("same pid, alive, different executable → different-generation (pid reuse)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: true, executable: "/usr/bin/other-server" },
  });
  expect(result.kind).toBe("different-generation");
  expect(result).toMatchObject({ kind: "different-generation", reason: "pid-reused" });
});

test("same pid, alive, matching startTimeMs but different executable → different-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: true, startTimeMs: 1000, executable: "/usr/bin/other-server" },
  });
  expect(result.kind).toBe("different-generation");
});

test("same pid, alive, matching executable but different startTimeMs → different-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: true, startTimeMs: 2000, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("different-generation");
});

test("same pid, alive, no shared identity field → different-generation", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: true, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("different-generation");
});

test("same pid, not alive, observation has startTimeMs → verified-absent", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: false, startTimeMs: 1000 },
  });
  expect(result.kind).toBe("verified-absent");
});

test("matching executable alone cannot prove generation absence", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: false, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("uncertain");
});

test("same pid, not alive, no identifying fields → uncertain (unidentified-absence)", () => {
  const result = judgeGeneration({
    recorded: { pid: 100 },
    observation: { pid: 100, alive: false },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "unidentified-absence" });
});

test("same pid, not alive, observation startTimeMs contradicts recorded → uncertain", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: false, startTimeMs: 2000 },
  });
  expect(result.kind).toBe("uncertain");
});

test("same pid, not alive, observation executable contradicts recorded → uncertain", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" },
    observation: { pid: 100, alive: false, startTimeMs: 1000, executable: "/usr/bin/other-server" },
  });
  expect(result.kind).toBe("uncertain");
});

test("same pid, not alive, no shared identity field → uncertain", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 100, alive: false, executable: "/usr/bin/llama-server" },
  });
  expect(result.kind).toBe("uncertain");
});

test("missing process evidence cannot prove absence", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: undefined,
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation" });
});

test("a different observed PID cannot prove absence", () => {
  const result = judgeGeneration({
    recorded: { pid: 100, startTimeMs: 1000 },
    observation: { pid: 200, alive: true },
  });
  expect(result.kind).toBe("uncertain");
  expect(result).toMatchObject({ kind: "uncertain", reason: "no-observation-for-recorded-pid" });
});

test("inputs are not mutated", () => {
  const recorded = { pid: 100, startTimeMs: 1000, executable: "/usr/bin/llama-server" };
  const observation = {
    pid: 100,
    alive: true,
    startTimeMs: 1000,
    executable: "/usr/bin/llama-server",
  };
  const originalRecorded = JSON.stringify(recorded);
  const originalObservation = JSON.stringify(observation);

  expect(JSON.stringify(recorded)).toBe(originalRecorded);
  expect(JSON.stringify(observation)).toBe(originalObservation);
});

test("a durable birth identity takes precedence over a coarse start-time estimate", () => {
  const recorded = { pid: 100, birthId: "linux:boot:123", startTimeMs: 1000 };
  const observation = { pid: 100, alive: true, birthId: "linux:boot:124", startTimeMs: 1000 };
  expect(judgeGeneration({ recorded, observation }).kind).toBe("different-generation");
  expect(judgeGeneration({ recorded, observation: { ...observation, alive: false } }).kind).toBe(
    "uncertain",
  );
});

test("native absence proof can verify the exact birth without a wall-clock estimate", () => {
  const recorded = { pid: 100, birthId: "darwin:1712345678:9001" };
  const observation = { ...recorded, alive: false };
  expect(judgeGeneration({ recorded, observation }).kind).toBe("verified-absent");
  expect(judgeGeneration({ recorded, observation: { pid: 100, alive: false } }).kind).toBe(
    "uncertain",
  );
});
