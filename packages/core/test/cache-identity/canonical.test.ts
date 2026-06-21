import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  boundaryNaiveBytePrefixSha,
  canonicalRequestSha,
} from "../../src/cache-identity/canonical.js";

function sha1Hex(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

test("canonicalRequestSha is stable across JSON key reorder", () => {
  const left = '{"b":2,"a":1,"nested":{"y":2,"x":1}}';
  const right = '{"a":1,"nested":{"x":1,"y":2},"b":2}';
  expect(canonicalRequestSha(left)).toBe(canonicalRequestSha(right));
});

test("boundaryNaiveBytePrefixSha changes when bytes change", () => {
  expect(boundaryNaiveBytePrefixSha('{"a":1}')).not.toBe(boundaryNaiveBytePrefixSha('{"a": 1}'));
});

test("canonicalRequestSha and boundaryNaiveBytePrefixSha are stable across runs", () => {
  const payload = '{"z":3,"a":[2,1]}';
  const canonical = canonicalRequestSha(payload);
  const boundary = boundaryNaiveBytePrefixSha(payload);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(canonicalRequestSha(payload)).toBe(canonical);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
  expect(boundaryNaiveBytePrefixSha(payload)).toBe(boundary);
});

test("canonicalRequestSha ignores x_omlx_request_handle", () => {
  const withoutHandle = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
  });
  const withHandle = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
    x_omlx_request_handle: "req-123",
  });
  expect(canonicalRequestSha(withoutHandle)).toBe(canonicalRequestSha(withHandle));
});

test("canonicalRequestSha ignores x_omlx_restore_epoch", () => {
  const withoutEpoch = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
  });
  const withEpoch = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
    x_omlx_restore_epoch: "epoch-abc",
  });
  expect(canonicalRequestSha(withoutEpoch)).toBe(canonicalRequestSha(withEpoch));
});

test("canonicalRequestSha still distinguishes unrelated fields", () => {
  const baseline = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
  });
  const changed = JSON.stringify({
    model: "mlx-community/Qwen3-8B-MLX-4bit",
    messages: [{ role: "user", content: "hello" }],
    temperature: 0,
  });
  expect(canonicalRequestSha(baseline)).not.toBe(canonicalRequestSha(changed));
});

test("canonicalRequestSha sorts keys by codepoint, not locale collation", () => {
  // localeCompare is locale/ICU-dependent: under en-US it sorts "Z" AFTER "a"
  // (codepoint puts "Z"=90 BEFORE "a"=97), so a locale-sensitive sort would
  // make this cross-node cache identity diverge across nodes/locales. Pin the
  // canonical SHA to the deterministic codepoint order.
  const payload = '{"a":1,"Z":2}';
  // Codepoint order of the keys is ["Z","a"]; the canonical form must match.
  const codepointCanonical = JSON.stringify({ Z: 2, a: 1 });
  expect(canonicalRequestSha(payload)).toBe(sha1Hex(codepointCanonical));
});

test("canonicalRequestSha is byte-identical regardless of process locale", () => {
  // A key set whose locale order (diacritics, mixed case) differs from
  // codepoint order. Flipping LC_ALL must not change the SHA.
  const payload = '{"z":1,"a":2,"ä":3,"o":4,"ö":5,"Z":6}';
  const prevLcAll = process.env["LC_ALL"];
  try {
    process.env["LC_ALL"] = "en_US.UTF-8";
    const enUs = canonicalRequestSha(payload);
    process.env["LC_ALL"] = "C";
    const cLocale = canonicalRequestSha(payload);
    expect(enUs).toBe(cLocale);
    // And it equals the explicit codepoint-sorted canonical form.
    const codepointCanonical = JSON.stringify({ Z: 6, a: 2, o: 4, z: 1, ä: 3, ö: 5 });
    expect(enUs).toBe(sha1Hex(codepointCanonical));
  } finally {
    if (prevLcAll === undefined) delete process.env["LC_ALL"];
    else process.env["LC_ALL"] = prevLcAll;
  }
});
