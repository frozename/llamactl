import { expect, test } from "bun:test";

import { __resolveStripVendorModelForTests } from "../src/openaiProxy.js";

// Change C pins the model string passed to stripUserSuppliedOmlxVendorFields.
// The previous code resolved it as:
//   requestedModelFromBody(bodyText) ?? route?.model ?? "unknown"
// where requestedModelFromBody(bodyText) === (typeof parsed.model === "string" ? parsed.model : undefined).
// The refactor reads the model from the ALREADY-parsed body object instead of
// re-parsing bodyText a second time. This helper isolates that exact fallback
// chain so the resolved string is provably identical across cases.

test("model present (string) in parsed body wins over route", () => {
  const model = __resolveStripVendorModelForTests({ model: "gpt-from-body" }, "route-model");
  expect(model).toBe("gpt-from-body");
});

test("model absent in body falls back to route.model", () => {
  const model = __resolveStripVendorModelForTests({ other: 1 }, "route-model");
  expect(model).toBe("route-model");
});

test("model non-string in body falls back to route.model (mirrors requestedModelFromBody)", () => {
  const model = __resolveStripVendorModelForTests({ model: 42 }, "route-model");
  expect(model).toBe("route-model");
});

test("model absent in body and no route model falls back to 'unknown'", () => {
  const model = __resolveStripVendorModelForTests({ other: 1 }, undefined);
  expect(model).toBe("unknown");
});

test("model non-string and no route model falls back to 'unknown'", () => {
  const model = __resolveStripVendorModelForTests({ model: null }, undefined);
  expect(model).toBe("unknown");
});
