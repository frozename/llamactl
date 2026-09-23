import type { OpsChatToolName } from "@llamactl/remote";

import { OPS_CHAT_TOOLS, opsChatToolTier as toolTier } from "@llamactl/remote";
import { afterAll, describe, expect, mock, test } from "bun:test";

// Snapshot the real exports before registering the mocks. mock.module is
// process-global, so re-registering the snapshots in afterAll keeps later
// test files in this bun process on the real modules. `@/` specifiers
// don't resolve under bun test, so the real modules are registered under
// those specifiers first — that both lets the snapshot targets load and
// leaves a real-module fallback for other files. Loading lib/trpc builds
// an IPC client at eval, which needs the preload bridge global.
const hadElectronTRPC = "electronTRPC" in globalThis;
const prevElectronTRPC = globalThis.electronTRPC;
globalThis.electronTRPC ??= {
  sendMessage: (): undefined => undefined,
  onMessage: (): undefined => undefined,
};

const trpcReal = { ...(await import("../src/lib/trpc")) };
const opsExecutorStoreReal = { ...(await import("../src/stores/ops-executor-store")) };
const tabStoreReal = { ...(await import("../src/stores/tab-store")) };

void mock.module("@/lib/trpc", () => trpcReal);
void mock.module("@/stores/ops-executor-store", () => opsExecutorStoreReal);
void mock.module("@/stores/tab-store", () => tabStoreReal);

const executorPickerReal = {
  ...(await import("../src/modules/ops/ops-executor-picker")),
};
const useOpsChatReal = { ...(await import("../src/modules/ops-chat/use-ops-chat.js")) };

void mock.module("@/modules/ops/ops-executor-picker", () => ({
  OpsExecutorPicker: (): null => null,
}));
void mock.module("../src/modules/ops-chat/use-ops-chat.js", () => ({
  useOpsChat: (): null => null,
}));

afterAll(() => {
  void mock.module("@/modules/ops/ops-executor-picker", () => executorPickerReal);
  void mock.module("../src/modules/ops-chat/use-ops-chat.js", () => useOpsChatReal);
  if (hadElectronTRPC) globalThis.electronTRPC = prevElectronTRPC;
  else delete (globalThis as { electronTRPC?: unknown }).electronTRPC;
});

describe("Ops Chat default catalog parity", () => {
  test("DEFAULT_CATALOG entries exist in the ops-chat registry with matching tiers", async () => {
    const { DEFAULT_CATALOG } = await import("../src/modules/ops-chat/index.js");
    const registryNames = new Set<string>(OPS_CHAT_TOOLS.map((tool) => tool.name));

    for (const entry of DEFAULT_CATALOG) {
      // entry.name is widened to `string` in DEFAULT_CATALOG; this membership
      // assertion proves it is a real registry tool name before we treat it as
      // the registry's literal-union type below.
      expect(registryNames.has(entry.name)).toBe(true);
      expect(toolTier(entry.name as OpsChatToolName)).toBe(entry.tier);
    }
  });
});
