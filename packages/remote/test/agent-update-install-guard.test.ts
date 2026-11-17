// Pins #745: /agent/update refuses a non-compiled or unstamped agent.

import type { nodeFacts } from "@llamactl/core";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { type AgentUpdateOptions, handleAgentUpdate } from "../src/server/agent-update.js";

/**
 * #745 install guard. A source checkout or an unstamped /$bunfs/ fallback
 * must be refused with a 409 before the sha header or the body is even
 * looked at — the running binary's own build stamp decides, never the
 * basename it happens to be installed under. Hermetic: temp selfPath,
 * injected stamp, exitAfter:false, no sleeps, spawns or network.
 */

const BEARER = "agt_install_guard_token_745";
const TOKEN_HASH = createHash("sha256").update(BEARER).digest("hex");
const ORIGINAL_BYTES = Buffer.from("#!/bin/sh\necho v1\n");

const SOURCE: nodeFacts.BuildStamp = {
  commit: "a".repeat(40),
  dirty: null,
  builtAt: null,
  installKind: "source",
};
const UNSTAMPED_COMPILED: nodeFacts.BuildStamp = {
  commit: null,
  dirty: null,
  builtAt: null,
  installKind: "compiled",
};
const COMPILED_HEAD_ONLY: nodeFacts.BuildStamp = {
  commit: "b".repeat(40),
  dirty: null,
  builtAt: null,
  installKind: "compiled",
};
const STAMPED_COMPILED: nodeFacts.BuildStamp = {
  commit: "f".repeat(40),
  dirty: false,
  builtAt: "2026-11-01T00:00:00.000Z",
  installKind: "compiled",
};
const COMPILED_NON_HEX_COMMIT: nodeFacts.BuildStamp = {
  commit: "unknown",
  dirty: false,
  builtAt: "2026-11-01T00:00:00.000Z",
  installKind: "compiled",
};
const SOURCE_WITH_FIELDS: nodeFacts.BuildStamp = {
  commit: "c".repeat(40),
  dirty: false,
  builtAt: "2026-11-01T00:00:00.000Z",
  installKind: "source",
};

let tmp = "";
let selfPath = "";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-update-install-guard-"));
  selfPath = join(tmp, "llamactl-agent");
  writeFileSync(selfPath, ORIGINAL_BYTES);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function shaHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function postReq(
  body: Uint8Array,
  opts: { sha?: string; bearer?: string; omitSha?: boolean } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/octet-stream" };
  headers["authorization"] = `Bearer ${opts.bearer ?? BEARER}`;
  if (!opts.omitSha) {
    headers["x-sha256"] = opts.sha ?? shaHex(body);
  }
  return new Request("http://test/agent/update", {
    method: "POST",
    headers,
    body: Uint8Array.from(body),
  });
}

function updateOpts(stamp?: nodeFacts.BuildStamp): AgentUpdateOptions {
  return {
    tokenHash: TOKEN_HASH,
    selfPath,
    exitAfter: false,
    ...(stamp === undefined ? {} : { buildStamp: stamp }),
  };
}

async function expectInstallRefusal(res: Response, messagePart: string): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { ok: boolean; message: string };
  expect(body.ok).toBe(false);
  expect(body.message).toContain(messagePart);
  expect(readFileSync(selfPath)).toEqual(ORIGINAL_BYTES);
  expect(existsSync(`${selfPath}.previous`)).toBe(false);
  expect(existsSync(join(tmp, ".llamactl-agent.staging"))).toBe(false);
}

describe("handleAgentUpdate — install-kind guard (#745)", () => {
  test("refuses a source-checkout agent even though the basename looks compiled", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(SOURCE),
    );
    await expectInstallRefusal(
      res,
      "refusing-update: agent is not a compiled binary (installKind=source)",
    );
  });

  test("refuses a compiled installKind carrying no stamp fields at all", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(UNSTAMPED_COMPILED),
    );
    await expectInstallRefusal(res, "refusing-update: compiled agent has no build stamp");
  });

  test("refuses a compiled stamp that only carries the /$bunfs/ fallback commit", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(COMPILED_HEAD_ONLY),
    );
    await expectInstallRefusal(res, "refusing-update: compiled agent has no build stamp");
  });

  test("refuses a compiled stamp whose commit is set but not a 40-hex SHA", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(COMPILED_NON_HEX_COMMIT),
    );
    await expectInstallRefusal(res, "refusing-update: compiled agent has no build stamp");
  });

  test("refuses installKind=source even when every stamp field is populated", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(SOURCE_WITH_FIELDS),
    );
    await expectInstallRefusal(res, "installKind=source");
  });

  test("the install guard fires before x-sha256 validation", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n")), { omitSha: true }),
      updateOpts(SOURCE),
    );
    await expectInstallRefusal(res, "installKind=source");
  });

  test("accepts a compiled agent carrying a full build stamp", async () => {
    const next = new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"));
    const res = await handleAgentUpdate(postReq(next), updateOpts(STAMPED_COMPILED));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; newSha256: string };
    expect(body.ok).toBe(true);
    expect(body.newSha256).toBe(shaHex(next));
    expect(readFileSync(selfPath)).toEqual(Buffer.from(next));
    expect(readFileSync(`${selfPath}.previous`)).toEqual(ORIGINAL_BYTES);
  });

  test("defaults to resolveBuildStamp() when no buildStamp is injected", async () => {
    const res = await handleAgentUpdate(
      postReq(new Uint8Array(Buffer.from("#!/bin/sh\necho v2\n"))),
      updateOpts(),
    );
    await expectInstallRefusal(res, "installKind=source");
  });
});
