import { describe, expect, test } from "bun:test";

import { buildServerArgs } from "../src/server.js";

describe("buildServerArgs", () => {
  test("pins Apple Silicon flags and includes -ub", () => {
    const args = buildServerArgs({
      modelPath: "/models/foo.gguf",
      port: 18181,
      ub: 256,
    });
    expect(args).toEqual([
      "--host",
      "127.0.0.1",
      "--port",
      "18181",
      "--model",
      "/models/foo.gguf",
      "--ctx-size",
      "8192",
      "--no-warmup",
      "-np",
      "1",
      "-ngl",
      "999",
      "--flash-attn",
      "on",
      "-ub",
      "256",
    ]);
  });

  test("supports flash-attn opt-out for spot validation", () => {
    const args = buildServerArgs({
      modelPath: "/x.gguf",
      port: 18181,
      ub: 512,
      flashAttn: false,
    });
    expect(args).toContain("--flash-attn");
    expect(args).toContain("off");
  });

  test("supports ctx override for context sub-bench", () => {
    const args = buildServerArgs({
      modelPath: "/x.gguf",
      port: 18181,
      ub: 512,
      ctxSize: 16896,
    });
    expect(args).toContain("16896");
  });
});
