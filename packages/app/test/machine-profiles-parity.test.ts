import { MACHINE_PROFILES } from "@llamactl/core/types";
import { describe, expect, test } from "bun:test";

import { PROFILES as presetsProfiles } from "../src/modules/presets/types";
import { PROFILES as pullsProfiles } from "../src/modules/pulls/types";
import { PROFILES as settingsProfiles } from "../src/modules/settings/types";

describe("machine profile pickers", () => {
  test("presets PROFILES matches MACHINE_PROFILES", () => {
    expect([...presetsProfiles]).toEqual([...MACHINE_PROFILES]);
  });

  test("pulls PROFILES matches MACHINE_PROFILES", () => {
    expect([...pullsProfiles]).toEqual([...MACHINE_PROFILES]);
  });

  test("settings PROFILES matches MACHINE_PROFILES", () => {
    expect([...settingsProfiles]).toEqual([...MACHINE_PROFILES]);
  });
});
