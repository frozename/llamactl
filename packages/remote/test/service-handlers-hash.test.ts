import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { canonicalStringify, sha256Hex } from "../src/service/handlers/hash.js";

describe("canonicalStringify", () => {
  test("sorts object keys recursively", () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test("keeps array element order", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  test("canonicalizes objects inside arrays", () => {
    expect(canonicalStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  test("drops undefined object fields", () => {
    expect(canonicalStringify({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalStringify({ a: 1 })).toBe('{"a":1}');
    expect(canonicalStringify({ a: { x: undefined, y: 2 } })).toBe('{"a":{"y":2}}');
  });

  test("serializes undefined array slots as null", () => {
    expect(canonicalStringify([1, undefined])).toBe("[1,null]");
  });

  test("preserves null values and a top-level null", () => {
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
    expect(canonicalStringify(null)).toBe("null");
  });

  test("passes primitives through", () => {
    expect(canonicalStringify("x")).toBe('"x"');
    expect(canonicalStringify(42)).toBe("42");
    expect(canonicalStringify(true)).toBe("true");
  });

  test("does not reorder the caller's object", () => {
    const input: Record<string, unknown> = { b: 1, a: 2 };
    canonicalStringify(input);
    expect(Object.keys(input)).toEqual(["b", "a"]);
  });
});

describe("sha256Hex", () => {
  test("is the lowercase hex sha256 of the canonical string", () => {
    const v = { b: [{ d: 1, c: 2 }], a: "x" };
    expect(sha256Hex(v)).toBe(createHash("sha256").update(canonicalStringify(v)).digest("hex"));
    expect(sha256Hex(v)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("pins known digests", () => {
    expect(sha256Hex({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expect(sha256Hex({ b: 1, a: 2 })).toBe(
      "d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772",
    );
  });

  test("is independent of key order at every depth", () => {
    const h1 = sha256Hex({
      b: 1,
      a: { d: [{ z: 1, y: 2 }], c: 3 },
    });
    const h2 = sha256Hex({
      a: { c: 3, d: [{ y: 2, z: 1 }] },
      b: 1,
    });
    expect(h1).toBe(h2);
  });
});
