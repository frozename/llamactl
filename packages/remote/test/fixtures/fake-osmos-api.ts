/**
 * Fake osmos-api for test/workload/modelhost-libosmos.test.ts (#557 S3).
 *
 * Speaks the slice of the osmos-api wire the libosmos adapter needs:
 * --config/--host/--port argv, a config JSON it only reads `pack` from,
 * /v1/models advertising `osmos-<pack>` immediately, and a /health that
 * reports loading (503) for its first two hits before ok (200). Every
 * /health status is appended to <config dir>/health.log and the launch
 * argv to <config dir>/argv.json so the test can assert both. Exits 0 on
 * SIGTERM. NOT run under `bun test` — spawned through the test's bash
 * wrapper with `exec -a osmos-api`.
 */
import { dirname, join } from "node:path";

import { appendFileSync, readFileSync, writeFileSync } from "../../src/safe-fs.js";

interface OsmosConfig {
  pack?: string;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const configPath = argValue("--config");
const host = argValue("--host") ?? "127.0.0.1";
const port = Number.parseInt(argValue("--port") ?? "", 10);
if (configPath === undefined || !Number.isInteger(port) || port <= 0) {
  process.stderr.write("fake-osmos-api: requires --config <path> --host <h> --port <n>\n");
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, "utf8")) as OsmosConfig;
const stateDir = dirname(configPath);
writeFileSync(join(stateDir, "argv.json"), JSON.stringify(process.argv.slice(2)));

let healthHits = 0;
const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: `osmos-${cfg.pack ?? ""}`, object: "model", owned_by: "osmos" }],
      });
    }
    if (path === "/health") {
      healthHits += 1;
      const loading = healthHits <= 2;
      const status = loading ? 503 : 200;
      appendFileSync(join(stateDir, "health.log"), `${String(status)}\n`);
      return Response.json({ status: loading ? "loading" : "ok" }, { status });
    }
    return new Response("not found", { status: 404 });
  },
});

process.on("SIGTERM", () => {
  void server.stop();
  process.exit(0);
});
