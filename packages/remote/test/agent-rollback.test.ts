import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../src/safe-fs.js";
import { handleAgentRollback } from "../src/server/agent-update.js";

/**
 * Agent rollback endpoint. Tests run handleAgentRollback against a
 * temp "self" file rather than the live process binary, with
 * exitAfter:false so the test runner doesn't get killed by the
 * usual `setTimeout(() => process.exit(0), 200)`.
 */

const BEARER = "agt_test_token_12345";
const TOKEN_HASH = createHash("sha256").update(BEARER).digest("hex");

let tmp = "";
let selfPath = "";

const CURRENT = Buffer.from("#!/bin/sh\necho v2\n");
const PREVIOUS = Buffer.from("#!/bin/sh\necho v1\n");

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-rollback-"));
  selfPath = join(tmp, "llamactl-agent");
  writeFileSync(selfPath, CURRENT);
  writeFileSync(`${selfPath}.previous`, PREVIOUS);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function req(opts: { method?: string; bearer?: string | null } = {}): Request {
  const method = opts.method ?? "POST";
  const bearer: string | null = opts.bearer !== undefined ? opts.bearer : BEARER;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (bearer !== null) {
    headers["authorization"] = `Bearer ${bearer}`;
  }
  return new Request("http://test/agent/rollback", {
    method,
    headers,
  });
}

function sha(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function rollbackOpts(): Parameters<typeof handleAgentRollback>[1] {
  return { tokenHash: TOKEN_HASH, selfPath, exitAfter: false };
}

// ---------------------------------------------------------------------------
// Test 1: non-POST returns 405, files unchanged
// ---------------------------------------------------------------------------

describe("handleAgentRollback — method gate", () => {
  test("GET returns 405, both files byte-identical", () => {
    const beforeSelf = readFileSync(selfPath);
    const beforePrev = readFileSync(`${selfPath}.previous`);
    const res = handleAgentRollback(req({ method: "GET" }), rollbackOpts());
    expect(res.status).toBe(405);
    expect(readFileSync(selfPath)).toEqual(beforeSelf);
    expect(readFileSync(`${selfPath}.previous`)).toEqual(beforePrev);
  });
});

// ---------------------------------------------------------------------------
// Test 2: missing bearer returns 401 with error.code "UNAUTHORIZED"
// ---------------------------------------------------------------------------

describe("handleAgentRollback — auth", () => {
  test("missing bearer returns 401 with error.code UNAUTHORIZED", async () => {
    const beforeSelf = readFileSync(selfPath).toString();
    const res = handleAgentRollback(req({ bearer: null }), rollbackOpts());
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(readFileSync(selfPath).toString()).toBe(beforeSelf);
  });

  test("wrong bearer returns 401, files unchanged", () => {
    const beforeSelf = readFileSync(selfPath);
    const res = handleAgentRollback(req({ bearer: "nope" }), rollbackOpts());
    expect(res.status).toBe(401);
    expect(readFileSync(selfPath)).toEqual(beforeSelf);
  });
});

// ---------------------------------------------------------------------------
// Test 3: selfPath missing returns 500
// ---------------------------------------------------------------------------

describe("handleAgentRollback — selfPath preconditions", () => {
  test("selfPath does not exist returns 500 with message containing 'selfPath does not exist'", async () => {
    rmSync(selfPath);
    const res = handleAgentRollback(req(), rollbackOpts());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("selfPath does not exist");
    expect(existsSync(`${selfPath}.previous`)).toBe(true);
  });

  test("no .previous returns 409 with ok:false and message 'nothing to roll back to'", async () => {
    rmSync(`${selfPath}.previous`);
    const res = handleAgentRollback(req(), rollbackOpts());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("nothing to roll back to");
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v2\n");
  });
});

// ---------------------------------------------------------------------------
// Test 4: success — content swap, metadata, no swap file left behind
// ---------------------------------------------------------------------------

describe("handleAgentRollback — success", () => {
  test("swaps contents: selfPath now holds PREVIOUS bytes", () => {
    const res = handleAgentRollback(req(), rollbackOpts());
    expect(res.status).toBe(200);
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");
  });

  test("keeps the rolled-out build at .previous (CURRENT bytes)", () => {
    handleAgentRollback(req(), rollbackOpts());
    expect(readFileSync(`${selfPath}.previous`).toString()).toBe("#!/bin/sh\necho v2\n");
  });

  test("response body: ok true, restoredAt === selfPath, newSha256 === sha(PREVIOUS), rolledOutSha256 === sha(CURRENT)", async () => {
    const res = handleAgentRollback(req(), rollbackOpts());
    const body = (await res.json()) as {
      ok: boolean;
      restoredAt: string;
      newSha256: string;
      rolledOutSha256: string;
    };
    expect(body.ok).toBe(true);
    expect(body.restoredAt).toBe(selfPath);
    expect(body.newSha256).toBe(sha(PREVIOUS));
    expect(body.rolledOutSha256).toBe(sha(CURRENT));
  });

  test("leaves no .swap file behind", () => {
    handleAgentRollback(req(), rollbackOpts());
    expect(existsSync(`${selfPath}.swap`)).toBe(false);
  });

  test("marks the restored binary executable (mode 0o755)", () => {
    writeFileSync(`${selfPath}.previous`, PREVIOUS, { mode: 0o644 });
    const res = handleAgentRollback(req(), rollbackOpts());
    expect(res.status).toBe(200);
    const mode = statSync(selfPath).mode & 0o777;
    expect(mode).toBe(0o755);
  });
});

// ---------------------------------------------------------------------------
// Test 5: symmetry — two rollbacks restore original state
// ---------------------------------------------------------------------------

describe("handleAgentRollback — symmetry", () => {
  test("two successful calls put CURRENT back at selfPath; second response newSha256 === sha(CURRENT)", async () => {
    // First rollback: selfPath gets PREVIOUS, .previous gets CURRENT
    handleAgentRollback(req(), rollbackOpts());
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v1\n");

    // Second rollback: selfPath gets CURRENT back, .previous gets PREVIOUS back
    const res2 = handleAgentRollback(req(), rollbackOpts());
    expect(res2.status).toBe(200);
    expect(readFileSync(selfPath).toString()).toBe("#!/bin/sh\necho v2\n");
    const body = (await res2.json()) as { newSha256: string };
    expect(body.newSha256).toBe(sha(CURRENT));
  });
});
