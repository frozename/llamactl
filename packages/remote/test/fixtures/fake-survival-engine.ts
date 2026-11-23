/**
 * Fake inference engine for test/server/engine-survival.test.ts (#806 phase 1)
 * and test/server/engine-adopt.test.ts (#806 phase 2).
 *
 * Stands in for a real llama-server: it binds the loopback endpoint it is
 * handed on argv and answers the two probes llamactl uses — /v1/models (the
 * ModelHost readiness poll and the proxy listing) and /health (the ModelRun
 * readiness poll and serverStatus). It writes nothing itself: the survival
 * contract is about the stdio the launcher wired up, not what the engine
 * logs. Exits 0 on SIGTERM/SIGINT so a stop or a reaper can take it down.
 *
 * FAKE_SURVIVAL_SICK_DIR (phase 2): when set, a file named for this engine's
 * pid inside that directory holding an integer N > 0 makes the next N
 * requests to /health and /v1/models answer 503; each served request rewrites
 * the file to N-1 and deletes it at 0. Keying on pid means a replacement
 * engine (a new pid) is healthy without any reset.
 *
 * NOT run under `bun test`. It is spawned detached through the real launch
 * paths via a bash wrapper that does `exec -a llama-server <bun> <this file>`,
 * so `ps` and the pid-identity argv0 check see `llama-server`.
 */

import { join } from "node:path";

import { readFileSync, unlinkSync, writeFileSync } from "../../src/safe-fs.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const host = argValue("--host") ?? "127.0.0.1";
const port = Number.parseInt(argValue("--port") ?? "", 10);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("fake-survival-engine: requires --port <n>\n");
  process.exit(1);
}

const modelId = process.env["FAKE_SURVIVAL_MODEL_ID"] ?? "survival-model";
const sickDir = process.env["FAKE_SURVIVAL_SICK_DIR"];
const sickFile = sickDir === undefined ? null : join(sickDir, String(process.pid));

// One sick request consumes one count; returns true when this request must
// answer 503. A missing, unreadable or non-positive file means healthy.
function consumeSickRequest(): boolean {
  if (sickFile === null) return false;
  let remaining: number;
  try {
    remaining = Number(readFileSync(sickFile, "utf8").trim());
  } catch {
    return false;
  }
  if (!Number.isInteger(remaining) || remaining <= 0) return false;
  const next = remaining - 1;
  try {
    if (next <= 0) {
      unlinkSync(sickFile);
    } else {
      writeFileSync(sickFile, `${String(next)}\n`);
    }
  } catch {
    // Best-effort bookkeeping; a failed rewrite just leaves the count high.
  }
  return true;
}

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/v1/models" || path === "/health") {
      if (consumeSickRequest()) {
        return new Response("sick", { status: 503 });
      }
    }
    if (path === "/v1/models") {
      return Response.json({
        object: "list",
        data: [{ id: modelId, object: "model", owned_by: "llamactl-test" }],
      });
    }
    if (path === "/health") {
      return Response.json({ status: "ok" });
    }
    return new Response("not found", { status: 404 });
  },
});

function shutdown(): void {
  void server.stop();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
