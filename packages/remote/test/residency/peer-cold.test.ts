import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dispatchPinnedPeerCold } from "../../src/proxy/peer-cold-client.js";
import { createPeerColdHandler, peerColdBodyDigest } from "../../src/residency/peer-cold.js";
import { mkdtempSync, readFileSync, rmSync } from "../../src/safe-fs.js";
import { hashToken } from "../../src/server/auth.js";
import { generateSelfSignedCert } from "../../src/server/tls.js";

const token = "fixture-peer-cold-service";
const publicToken = "fixture-inference-only";
const artifactRevision = `sha256:${"a".repeat(64)}`;
const policyRevision = `sha256:${"b".repeat(64)}`;
const declared: ColdEngineDispatch["declaration"] = {
  id: "fixture/model",
  workload: "fixture-run",
  kind: "ModelRun",
  ownerNodeId: "worker-a",
  state: "cold",
  autoLoadEligible: true,
};
const completion = JSON.stringify({ model: declared.id, prompt: [1], max_tokens: 3 });
const resolveInput = {
  version: 1,
  requestId: "36161425-6687-4f18-8ac9-64559d56a4d3",
  owner: declared.ownerNodeId,
  model: declared.id,
  workload: declared.workload,
  artifactRevision,
  policyRevision,
  bodyDigest: peerColdBodyDigest(completion),
  path: "/v1/completions",
  budgetMs: 30_000,
};

function request(path: string, input: unknown, bearer = token): Request {
  return new Request(`https://worker.invalid/_llamactl/peer-cold/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

test("a scoped peer receipt admits one exact request and refuses public credentials and replay", async () => {
  let invocations = 0;
  let now = 3000;
  const handle = createPeerColdHandler({
    nodeName: "worker-a",
    nowMs: () => now,
    credentials: [{ name: "gateway-a", tokenHash: hashToken(token), models: [declared.id] }],
    readDeclarations: () => [declared],
    bind: (entry, revision) => {
      expect(entry.id).toBe(declared.id);
      expect(revision).toEqual({ artifactRevision, policyRevision });
      return (input): Promise<Response> => {
        invocations++;
        expect(input.principal).toEqual({ service: "peer-cold", scope: "gateway-a" });
        expect(input.path).toBe("/v1/completions");
        expect(input.body).toBe(JSON.stringify({ model: declared.id, prompt: [1], max_tokens: 3 }));
        return Promise.resolve(new Response(null, { status: 204 }));
      };
    },
  });
  expect((await handle(request("resolve", resolveInput, publicToken))).status).toBe(401);
  const issued = await handle(request("resolve", resolveInput));
  expect(issued.status).toBe(200);
  const { receipt } = (await issued.json()) as { receipt: string };
  const input = { receipt, completion };
  expect((await handle(request("execute", input, publicToken))).status).toBe(401);
  const swapped = {
    ...input,
    completion: JSON.stringify({ model: declared.id, prompt: [2], max_tokens: 3 }),
  };
  expect((await handle(request("execute", swapped))).status).toBe(409);
  expect(invocations).toBe(0);
  expect((await handle(request("execute", input))).status).toBe(204);
  expect((await handle(request("execute", input))).status).toBe(409);
  expect((await handle(request("resolve", resolveInput))).status).toBe(409);
  expect(invocations).toBe(1);

  const fresh = await handle(
    request("resolve", { ...resolveInput, requestId: crypto.randomUUID() }),
  );
  const unused = (await fresh.json()) as { receipt: string };
  now += 15_001;
  expect((await handle(request("execute", { ...input, receipt: unused.receipt }))).status).toBe(
    409,
  );
  expect(invocations).toBe(1);
  for (let i = 0; i < 8; i++) {
    const accepted = await handle(
      request("resolve", { ...resolveInput, requestId: crypto.randomUUID() }),
    );
    expect(accepted.status).toBe(200);
  }
  const overflow = await handle(
    request("resolve", { ...resolveInput, requestId: crypto.randomUUID() }),
  );
  expect(overflow.status).toBe(429);
  expect(overflow.headers.get("retry-after")).toBe("1");
});

test("an accepted peer execution with an incomplete non-stream response is unknown and never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llamactl-peer-reply-loss-"));
  let server: Bun.Server<undefined> | undefined;
  let submissions = 0;
  try {
    const cert = await generateSelfSignedCert({ dir, commonName: "127.0.0.1" });
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: { cert: cert.certPem, key: readFileSync(cert.keyPath, "utf8") },
      fetch(req): Response {
        if (new URL(req.url).pathname.endsWith("/resolve")) {
          return Response.json({ version: 1, receipt: crypto.randomUUID() });
        }
        submissions++;
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller): void {
              controller.enqueue(encoder.encode('{"incomplete":'));
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const input = {
      node: {
        name: declared.ownerNodeId,
        endpoint: server.url.origin,
        certificate: cert.certPem,
        certificateFingerprint: cert.fingerprint,
      },
      serviceCredential: token,
      declaration: {
        ...declared,
        model: declared.id,
        artifactRevision,
        policyRevision,
      },
      path: "/v1/completions" as const,
      body: { model: declared.id, prompt: [1] },
      deadlineMs: Date.now() + 700,
      signal: new AbortController().signal,
    };
    const stopped = await dispatchPinnedPeerCold({
      ...input,
      stillSelected: () => Promise.resolve(false),
    });
    expect(stopped.status).toBe(503);
    expect(submissions).toBe(0);

    const failed = await dispatchPinnedPeerCold({
      ...input,
      deadlineMs: Date.now() + 700,
      stillSelected: () => Promise.resolve(true),
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { code: "peer_cold_outcome_unknown" } });
    expect(submissions).toBe(1);
  } finally {
    if (server !== undefined) await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
