// packages/remote/test/search-rag-node.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { resolveDefaultRagNode } from "../src/search/rag-node.js";

describe("resolveDefaultRagNode", () => {
  let tmp: string;
  let prev: string | undefined;
  let prevConfig: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "rag-node-"));
    prev = process.env["DEV_STORAGE"];
    prevConfig = process.env["LLAMACTL_CONFIG"];
    delete process.env["LLAMACTL_CONFIG"];
    process.env["DEV_STORAGE"] = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env["DEV_STORAGE"];
    else process.env["DEV_STORAGE"] = prev;

    if (prevConfig === undefined) delete process.env["LLAMACTL_CONFIG"];
    else process.env["LLAMACTL_CONFIG"] = prevConfig;

    rmSync(tmp, { recursive: true, force: true });
  });

  test("returns null when no RAG node configured", () => {
    writeFileSync(
      join(tmp, "config"),
      [
        "apiVersion: llamactl/v1",
        "kind: Config",
        "currentContext: local",
        "contexts:",
        "  - name: local",
        "    cluster: local",
        "    user: local",
        "clusters:",
        "  - name: local",
        "    nodes:",
        "      - name: local",
        "        kind: agent",
        "        endpoint: inproc://local",
      ].join("\n"),
      "utf8",
    );
    const out = resolveDefaultRagNode();
    expect(out).toBeNull();
  });

  test("returns first node with kind=rag", () => {
    writeFileSync(
      join(tmp, "config"),
      [
        "apiVersion: llamactl/v1",
        "kind: Config",
        "currentContext: local",
        "contexts:",
        "  - name: local",
        "    cluster: local",
        "    user: local",
        "clusters:",
        "  - name: local",
        "    nodes:",
        "      - name: local",
        "        kind: agent",
        "        endpoint: inproc://local",
        "      - name: chroma-1",
        "        kind: rag",
        "        rag:",
        "          provider: chroma",
        "          endpoint: http://localhost:8000",
        "      - name: chroma-2",
        "        kind: rag",
        "        rag:",
        "          provider: chroma",
        "          endpoint: http://localhost:8001",
      ].join("\n"),
      "utf8",
    );
    const out = resolveDefaultRagNode();
    expect(out).toBe("chroma-1");
  });
});
