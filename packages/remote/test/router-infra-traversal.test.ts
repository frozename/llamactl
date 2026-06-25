import { describe, test } from "bun:test";

import { router } from "../src/router.js";

// The infra tRPC procedures take pkg/version values that flow into
// filesystem joins on the agent host. The router's Zod schema must
// fail-closed for any value containing path separators or the
// literal '.' / '..' tokens — defense in depth alongside the
// layout-layer guard in src/infra/layout.ts.

async function rejected(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the procedure to reject the input");
}

const escapeValues = ["..", ".", "../etc", "a/b", "a\\b", "", "..%2F.."];

describe("infra procedures reject path-traversal inputs", () => {
  for (const bad of escapeValues) {
    test(`infraUninstall rejects pkg=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraUninstall({ pkg: bad }));
    });

    test(`infraUninstall rejects version=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraUninstall({ pkg: "llama-cpp", version: bad }));
    });

    test(`infraActivate rejects pkg=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraActivate({ pkg: bad, version: "b4500" }));
    });

    test(`infraActivate rejects version=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraActivate({ pkg: "llama-cpp", version: bad }));
    });

    test(`infraServiceWriteUnit rejects pkg=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraServiceWriteUnit({ pkg: bad }));
    });

    test(`infraServiceLifecycle rejects pkg=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraServiceLifecycle({ pkg: bad, action: "status" }));
    });

    test(`infraCurrent rejects pkg=${JSON.stringify(bad)}`, async () => {
      const caller = router.createCaller({});
      await rejected(caller.infraCurrent({ pkg: bad }));
    });
  }
});
