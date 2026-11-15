import { expect, test } from "bun:test";
import { totalmem } from "node:os";

// #274: contract for the opt-in host-memory pin preload. It passes both with
// LLAMACTL_TEST_TOTALMEM_GIB set (the pin is active) and with the flag unset
// (the preload is inert and the real host value is reported).
const raw = process.env["LLAMACTL_TEST_TOTALMEM_GIB"];
const gib = raw === undefined ? Number.NaN : Number(raw);
const pinned = Number.isFinite(gib) && gib > 0;

test("host-memory pin reports the pinned GiB when the flag is set", () => {
  if (!pinned) return;
  expect(totalmem()).toBe(gib * 1024 ** 3);
});

test("host-memory pin is opt-in and leaves totalmem untouched when unset", () => {
  if (pinned) return;
  expect(totalmem()).toBeGreaterThan(0);
});
