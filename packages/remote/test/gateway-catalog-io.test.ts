import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbersynthNode } from "../src/config/embersynth.js";
import type { SiriusProvider } from "../src/config/sirius-providers.js";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { readGatewayCatalog, writeGatewayCatalog } from "../src/workload/gateway-catalog/io.js";

describe("gateway-catalog io", () => {
  let tmp: string;
  let prevSp: string | undefined;
  let prevEm: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gc-io-"));
    prevSp = process.env["LLAMACTL_SIRIUS_PROVIDERS"];
    prevEm = process.env["LLAMACTL_EMBERSYNTH_CONFIG"];
    process.env["LLAMACTL_SIRIUS_PROVIDERS"] = join(tmp, "sp.yaml");
    process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = join(tmp, "em.yaml");
  });

  afterEach(() => {
    if (prevSp === undefined) delete process.env["LLAMACTL_SIRIUS_PROVIDERS"];
    else process.env["LLAMACTL_SIRIUS_PROVIDERS"] = prevSp;
    if (prevEm === undefined) delete process.env["LLAMACTL_EMBERSYNTH_CONFIG"];
    else process.env["LLAMACTL_EMBERSYNTH_CONFIG"] = prevEm;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("sirius round-trip", () => {
    writeGatewayCatalog("sirius", [
      { name: "a", kind: "openai-compatible", baseUrl: "http://h/v1" } satisfies SiriusProvider,
    ]);
    const out = readGatewayCatalog("sirius");
    expect(out.length).toBe(1);
    expect(out[0]!.name).toBe("a");
  });

  test("embersynth round-trip — preserves nodes", () => {
    writeGatewayCatalog("embersynth", [
      {
        id: "a",
        label: "a",
        endpoint: "http://h/v1",
        transport: "http",
        enabled: true,
        capabilities: [],
        tags: [],
        providerType: "openai-compatible",
        modelId: "default",
        priority: 5,
      } satisfies EmbersynthNode,
    ]);
    const out = readGatewayCatalog("embersynth");
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe("a");
  });

  test("reading missing sirius file returns empty array", () => {
    const out = readGatewayCatalog("sirius");
    expect(out).toEqual([]);
  });

  test("reading missing embersynth file returns empty array", () => {
    const out = readGatewayCatalog("embersynth");
    expect(out).toEqual([]);
  });
});
