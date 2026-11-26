import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../../src/safe-fs.js";
import { readObservedModels } from "../../src/workload/observed-models.js";

test("observes model IDs over a fixed loopback read and projects each configured state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-observed-"));
  const config = join(dir, "inventory.json");
  let reads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      reads += 1;
      expect(request.method).toBe("GET");
      expect(new URL(request.url).pathname).toBe("/v1/models");
      return Response.json({ data: [{ id: "granite", extra: "private" }] });
    },
  });
  const port = server.port!;
  try {
    expect(await readObservedModels(undefined, config)).toEqual({ state: "unconfigured" });
    expect(await readObservedModels(config)).toEqual({ state: "invalid-config" });
    await Bun.write(
      config,
      JSON.stringify([
        { port, model: "granite" },
        { port, model: "granite" },
        { port, model: "unlisted" },
      ]),
    );
    expect(await readObservedModels(config)).toEqual({
      state: "ready",
      models: [
        { port, model: "granite", state: "advertised" },
        { port, model: "unlisted", state: "missing" },
      ],
    });
    expect(reads).toBe(1);
    await server.stop(true);
    expect(await readObservedModels(config)).toMatchObject({
      state: "ready",
      models: [{ state: "unreachable" }, { state: "unreachable" }],
    });
    await Bun.write(config, JSON.stringify([{ port, model: "granite", host: "unexpected" }]));
    expect(await readObservedModels(config)).toEqual({ state: "invalid-config" });
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
