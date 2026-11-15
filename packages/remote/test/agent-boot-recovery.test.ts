/**
 * #279 DF-06 follow-up — RED tests pinning that profile-switch crash
 * recovery runs to completion inside `startAgentServer`, before it
 * returns: a leftover `profile-switch:<node>` row must already be
 * terminal on the first post-return read, and a recovery failure must
 * surface as one stderr line instead of blocking boot.
 *
 * Contract note (A1): the pin is "complete before startAgentServer
 * returns". A synchronous call moved after the bind is NOT detected —
 * it still satisfies the contract — and is out of scope here; only a
 * missing call or deferral past the return (promise, queueMicrotask,
 * setTimeout) fails.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openResidencyOperationStore, readResidencyStoreSnapshot } from "../src/residency/store.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { type RunningAgent, startAgentServer } from "../src/server/serve.js";
import { sandboxOperatorStorage } from "./storage-sandbox.js";

let dir = "";
let storePath = "";
let savedEnv: NodeJS.ProcessEnv = {};
let stderrChunks: string[] = [];
let originalStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  savedEnv = { ...process.env };
  dir = mkdtempSync(join(tmpdir(), "llamactl-agent-boot-recovery-"));
  sandboxOperatorStorage(process.env, dir);
  storePath = join(dir, "operations.sqlite");
  process.env["LLAMACTL_RESIDENCY_STORE"] = storePath;
  // Pins the profile so resolveEnv skips the sysctl memory probe.
  process.env["LLAMA_CPP_MACHINE_PROFILE"] = "balanced";
  stderrChunks = [];
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    stderrChunks.push(String(chunk));
    return true;
  };
});

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  for (const key of Object.keys(process.env)) {
    Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, savedEnv);
  if (dir !== "") {
    rmSync(dir, { recursive: true, force: true });
    dir = "";
  }
});

// Leaves the pending `profile-switch:n1` row a crashed switch would have
// begun under the agent/i1 fence, then closes the store — the leftover
// the next incarnation must recover at boot.
function seedCrashRow(): void {
  const store = openResidencyOperationStore({ path: storePath });
  try {
    const fence = store.claimOwnership({ ownerId: "agent", incarnation: "i1" });
    const begun = store.beginOperation({
      fenceToken: fence.fenceToken,
      operationId: "op-crash",
      model: "profile-switch:n1",
      targetState: "profile:interactive",
      desiredRevision: 1,
      reservationGiB: 0,
      nowMs: 1,
    });
    if (!begun.ok) {
      throw new Error(`seed beginOperation(op-crash) refused: ${begun.reason}`);
    }
  } finally {
    store.close();
  }
}

function startLoopbackAgent(): RunningAgent {
  return startAgentServer({
    bindHost: "127.0.0.1",
    port: 0,
    tokenHash: "0".repeat(64),
    noAuth: true,
    advertiseMdns: false,
    nodeName: "boot-node",
  });
}

function stderrText(): string {
  return stderrChunks.join("");
}

describe("agent boot profile-switch recovery (#279 DF-06)", () => {
  // Kills M3' (serve.ts never calls the boot recovery) and M4 (the call
  // is deferred through a promise, queueMicrotask or setTimeout): the
  // snapshot on the very next statement still sees the leftover row.
  // Contract note: "complete before startAgentServer returns" — a
  // synchronous call placed after the bind is NOT detected and is out
  // of scope; only deferral past the return or a missing call fails.
  test("recovery has completed before startAgentServer returns", async () => {
    seedCrashRow();

    let running: RunningAgent | null = null;
    try {
      running = startLoopbackAgent();
      const snap = readResidencyStoreSnapshot(storePath);
      expect(snap.present).toBe(true);
      if (!snap.present || !("nonterminal" in snap)) {
        throw new Error(
          `expected a residency snapshot with nonterminal rows: ${JSON.stringify(snap)}`,
        );
      }
      expect(snap.nonterminal).toEqual([]);
      expect(stderrText()).toContain("[residency] profile-switch boot recovery ");
    } finally {
      await running?.stop();
    }
  });

  // Kills M5': letting the recovery error propagate out of
  // startAgentServer — the agent must still return a running url and the
  // failure must land on stderr instead.
  test("a failing recovery does not prevent boot", async () => {
    writeFileSync(storePath, "not a sqlite database");

    let running: RunningAgent | null = null;
    try {
      running = startLoopbackAgent();
      expect(running.url.startsWith("http://")).toBe(true);
      expect(stderrText()).toContain("[residency] profile-switch boot recovery failed: ");
    } finally {
      await running?.stop();
    }
  });
});
