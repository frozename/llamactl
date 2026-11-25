// Part of #520.
import { expect, test } from "bun:test";
import { join } from "node:path";

import { enclosingBody, flat, readOrEmpty, REPO, sectionBody, sectionRe } from "./helpers.js";

test("D1: session affinity documents the unified-proxy worker-rpc session split", () => {
  // Kills: undocumented behaviour.
  const body = flat(sectionBody(sectionRe("session affinity")) ?? "");
  for (const pin of [
    "LLAMACTL_UNIFIED_PROXY",
    "x-llamactl-session",
    "worker-rpc",
    "gatedExecute",
    "packages/remote/src/proxy/create-proxy.ts",
    "sessionless",
    "legacy executor",
    "legacy route map",
    "keeps the worker RPC",
  ]) {
    expect(body).toContain(pin);
  }
});

test("D2: gatedExecute keys the session split on the worker-rpc transport and shared header", () => {
  // Kills: doc/source drift, or a private header literal.
  const createProxySrc = readOrEmpty(join(REPO, "packages/remote/src/proxy/create-proxy.ts"));
  const gated = enclosingBody(createProxySrc, "async function gatedExecute(");
  expect(gated).not.toBe("");
  expect(gated).toContain("carriesSessionHeader(");
  expect(gated).toContain('transport === "worker-rpc"');
  expect(createProxySrc).toContain("openaiProxy.SESSION_HEADER");

  const openaiProxySrc = readOrEmpty(join(REPO, "packages/core/src/openaiProxy.ts"));
  expect(openaiProxySrc).toContain('export const SESSION_HEADER = "x-llamactl-session"');
});
