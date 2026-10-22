import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtempSync, rmSync } from "../src/safe-fs.js";
import { generateToken, hashToken } from "../src/server/auth.js";
import { handleTunnelRelay } from "../src/server/tunnel-relay.js";
import { createTunnelServer } from "../src/tunnel/index.js";

/**
 * The 403 a relay-only credential (P4.1 X5) receives is all an operator
 * sees of the gate, so its wording is pinned: it names the worker-RPC
 * procedures, never an `inferenceRpc.` prefix that would read as admitting
 * any procedure under it.
 */

const RELAY_ONLY_REFUSAL = {
  error: { code: "FORBIDDEN", message: "this credential relays the worker-RPC procedures only" },
};

const dir = mkdtempSync(join(tmpdir(), "relay-only-refusal-"));
const journalPath = join(dir, "journal.jsonl");
const operator = generateToken();
const relay = generateToken();
const tunnelSrv = createTunnelServer({
  expectedBearerHash: hashToken(generateToken().token),
  journalPath,
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function relayAs(
  bearer: string,
  init: { verb?: string; query?: string; method?: string },
): Promise<Response> {
  const url = new URL(`http://127.0.0.1/tunnel-relay/node1${init.query ?? ""}`);
  const verb = init.verb ?? "POST";
  const req = new Request(String(url), {
    method: verb,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(verb === "POST"
      ? { body: JSON.stringify({ method: init.method, type: "query", input: null }) }
      : {}),
  });
  return handleTunnelRelay(req, url, tunnelSrv, operator.hash, journalPath, [relay.hash]);
}

describe("the relay-only refusal body", () => {
  test("names the worker-RPC procedures for any other method, streamed or not", async () => {
    for (const method of ["nodeList", "inferenceRpc.x", "inferenceRpc.drain"]) {
      for (const query of ["", "?stream=true"]) {
        const res = await relayAs(relay.token, { method, query });
        expect([method, query, res.status]).toEqual([method, query, 403]);
        expect(await res.json()).toEqual(RELAY_ONLY_REFUSAL);
      }
    }
  });

  test("names the worker-RPC procedures for a non-POST verb", async () => {
    const res = await relayAs(relay.token, { verb: "GET" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual(RELAY_ONLY_REFUSAL);
  });

  test("is not what a worker-RPC procedure, or the operator bearer, receives", async () => {
    // No node is connected, so a call past the gate fails at the tunnel send.
    const admitted = await relayAs(relay.token, { method: "inferenceRpc.negotiate" });
    expect(admitted.status).toBe(502);
    const operatorCall = await relayAs(operator.token, { method: "nodeList" });
    expect(operatorCall.status).toBe(502);
  });
});
