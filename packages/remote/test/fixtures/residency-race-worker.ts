/**
 * Cross-process residency race worker for store-lifecycle-contract.test.ts
 * (#517, DF-03 amendment). Two of these open the same node-local residency
 * store, and on a "go" byte line from stdin each fires one fenced
 * compare-and-set transition at the same row, so the parent can prove the
 * store's IMMEDIATE write lock serializes them instead of letting both apply.
 *
 * Protocol: print "ready\n", block until a stdin line arrives, run exactly one
 * transitionResidencyState, print one JSON result line. Every stdout write is a
 * synchronous writeSync to fd 1, so the parent never reads a torn line. The
 * target state is checked with a type guard before the store is opened. NOT
 * run under `bun test`; spawned directly with `bun` by the parent test.
 */
import { isResidencyState, type ResidencyState } from "@llamactl/core/residency/lifecycle";

import { openResidencyOperationStore } from "../../src/residency/store.js";
import { readSync, writeSync } from "../../src/safe-fs.js";

function fail(message: string): never {
  writeSync(2, `residency-race-worker: ${message}\n`);
  process.exit(1);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    fail(`missing required env ${name}`);
  }
  return value;
}

function requiredIntEnv(name: string): number {
  const raw = requiredEnv(name);
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    fail(`env ${name} must be an integer, got ${raw}`);
  }
  return parsed;
}

function emit(line: string): void {
  writeSync(1, `${line}\n`);
}

// Consume bytes from fd 0 until a newline or EOF, so the transition is gated on
// the parent's flushed "go" write rather than on process-start jitter.
function waitForGo(): void {
  const byte = Buffer.alloc(1);
  for (;;) {
    const read = readSync(0, byte, 0, 1, null);
    if (read === 0) {
      return;
    }
    if (byte[0] === 0x0a) {
      return;
    }
  }
}

const dbPath = requiredEnv("RESIDENCY_RACE_DB");
const model = requiredEnv("RESIDENCY_RACE_MODEL");
const toRaw = requiredEnv("RESIDENCY_RACE_TO");
const fenceToken = requiredIntEnv("RESIDENCY_RACE_FENCE");
const expectedVersion = requiredIntEnv("RESIDENCY_RACE_EXPECTED_VERSION");
const nowMs = requiredIntEnv("RESIDENCY_RACE_NOW");

if (!isResidencyState(toRaw)) {
  fail(`env RESIDENCY_RACE_TO is not a residency state, got ${toRaw}`);
}
const to: ResidencyState = toRaw;

const store = openResidencyOperationStore({ path: dbPath });
try {
  emit("ready");
  waitForGo();
  const result = store.transitionResidencyState({
    fenceToken,
    model,
    ...(process.env["RESIDENCY_RACE_GROUP"] === undefined
      ? {}
      : { group: requiredEnv("RESIDENCY_RACE_GROUP") }),
    to,
    expectedVersion,
    nowMs,
  });
  emit(JSON.stringify(result));
} catch (error: unknown) {
  fail(`transition threw: ${(error as Error).message}`);
} finally {
  store.close();
}
process.exit(0);
