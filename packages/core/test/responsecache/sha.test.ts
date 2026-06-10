import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalRequestSha } from "../../src/responsecache/index.js";

test("canonical sha is stable across JSON key reorder", () => {
  const left = '{"b":2,"a":1,"nested":{"y":2,"x":1}}';
  const right = '{"a":1,"nested":{"x":1,"y":2},"b":2}';
  expect(canonicalRequestSha(left)).toBe(canonicalRequestSha(right));
});

test("canonical sha for JSON bytes matches canonical sha for JSON string", () => {
  const body = '{"z":3,"a":1}';
  const bytes = new TextEncoder().encode(body);
  expect(canonicalRequestSha(bytes)).toBe(canonicalRequestSha(body));
});

test("non-JSON body hashes raw bytes", () => {
  const raw = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
  const expected = createHash("sha1").update(Buffer.from(raw)).digest("hex");
  expect(canonicalRequestSha(raw)).toBe(expected);
});
