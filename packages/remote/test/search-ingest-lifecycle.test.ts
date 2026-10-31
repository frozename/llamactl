import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionEventBus } from "../src/ops-chat/sessions/event-bus.js";
import { mkdtempSync, rmSync, writeFileSync } from "../src/safe-fs.js";
import { startSearchIngest, stopSearchIngest } from "../src/search/ingest/lifecycle.js";

test("no RAG destination leaves session ingestion inactive", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ingest-lifecycle-"));
  const previous = process.env["LLAMACTL_CONFIG"];
  process.env["LLAMACTL_CONFIG"] = join(tmp, "config");
  writeFileSync(
    join(tmp, "config"),
    JSON.stringify({
      apiVersion: "llamactl/v1",
      kind: "Config",
      currentContext: "local",
      contexts: [{ name: "local", cluster: "local", user: "local" }],
      clusters: [
        { name: "local", nodes: [{ name: "local", kind: "agent", endpoint: "inproc://local" }] },
      ],
    }),
  );
  const create = Object.getOwnPropertyDescriptor(sessionEventBus, "create")?.value as unknown;
  try {
    await startSearchIngest();
    expect(Object.getOwnPropertyDescriptor(sessionEventBus, "create")?.value).toBe(create);
    sessionEventBus.create("no-rag");
    expect(sessionEventBus.listenerCount("no-rag")).toBe(0);
  } finally {
    stopSearchIngest();
    sessionEventBus.close("no-rag");
    if (previous === undefined) delete process.env["LLAMACTL_CONFIG"];
    else process.env["LLAMACTL_CONFIG"] = previous;
    rmSync(tmp, { recursive: true, force: true });
  }
});
