/**
 * Fake inference engine for test/server/engine-survival.test.ts (#806 phase 1).
 *
 * Stands in for a real llama-server: it binds the loopback endpoint it is
 * handed on argv and answers the two probes llamactl uses — /v1/models (the
 * ModelHost readiness poll and the proxy listing) and /health (the ModelRun
 * readiness poll and serverStatus). It writes nothing itself: the survival
 * contract is about the stdio the launcher wired up, not what the engine
 * logs. Exits 0 on SIGTERM/SIGINT so a stop or a reaper can take it down.
 *
 * NOT run under `bun test`. It is spawned detached through the real launch
 * paths via a bash wrapper that does `exec -a llama-server <bun> <this file>`,
 * so `ps` and the pid-identity argv0 check see `llama-server`.
 */

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

const server = Bun.serve({
  hostname: host,
  port,
  fetch(request) {
    const path = new URL(request.url).pathname;
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
