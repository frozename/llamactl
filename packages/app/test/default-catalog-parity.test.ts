import { OPS_CHAT_TOOLS, opsChatToolTier as toolTier } from "@llamactl/remote";
import { describe, expect, mock, test } from "bun:test";

void mock.module("@/modules/ops/ops-executor-picker", () => ({
  OpsExecutorPicker: (): null => null,
}));
void mock.module("../src/modules/ops-chat/use-ops-chat.js", () => ({
  useOpsChat: (): null => null,
}));

describe("Ops Chat default catalog parity", () => {
  test("DEFAULT_CATALOG entries exist in the ops-chat registry with matching tiers", async () => {
    const { DEFAULT_CATALOG } = await import("../src/modules/ops-chat/index.js");
    const registryNames = new Set(OPS_CHAT_TOOLS.map((tool) => tool.name));

    for (const entry of DEFAULT_CATALOG) {
      expect(registryNames.has(entry.name)).toBe(true);
      expect(toolTier(entry.name)).toBe(entry.tier);
    }
  });
});
