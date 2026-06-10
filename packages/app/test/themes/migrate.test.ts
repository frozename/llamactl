import { describe, expect, test } from "bun:test";

import { type BeaconThemeId, migrateLegacyThemeId } from "../../src/themes/migrate";

describe("migrateLegacyThemeId", () => {
  test("glass → sirius", () => {
    expect(migrateLegacyThemeId("glass")).toEqual({ themeId: "sirius", extras: {} });
  });

  test("neon → sirius + scanlines opt-in", () => {
    expect(migrateLegacyThemeId("neon")).toEqual({
      themeId: "sirius",
      extras: { scanlines: true },
    });
  });

  test("ops → scrubs", () => {
    expect(migrateLegacyThemeId("ops")).toEqual({ themeId: "scrubs", extras: {} });
  });

  test("unknown legacy id → sirius default", () => {
    expect(migrateLegacyThemeId("unknown")).toEqual({
      themeId: "sirius",
      extras: {},
    });
  });

  test("pass-through: already-new beacon id returns as-is", () => {
    const idsToPreserve: BeaconThemeId[] = ["sirius", "ember", "clinical", "scrubs"];
    for (const id of idsToPreserve) {
      expect(migrateLegacyThemeId(id)).toEqual({ themeId: id, extras: {} });
    }
  });
});
