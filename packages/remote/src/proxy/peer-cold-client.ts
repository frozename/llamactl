import type { routingCatalog } from "@llamactl/core";
import type { ClusterNode } from "@llamactl/core/config/schema";
import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { z } from "zod";

import { makePinnedFetch } from "../client/links.js";
import {
  PEER_COLD_MAX_BODY_BYTES,
  PEER_COLD_ROUTE,
  peerColdBodyDigest,
  readPeerText,
} from "../residency/peer-cold.js";

type Declaration = routingCatalog.PeerDeclarationProvenanceV1["entries"][number];

interface PeerColdClientInput {
  node: ClusterNode;
  serviceCredential: string;
  declaration: Declaration;
  path: ColdEngineDispatch["path"];
  body: Readonly<Record<string, unknown>>;
  deadlineMs: number;
  signal: AbortSignal;
  stillSelected: () => Promise<boolean>;
}

const receiptSchema = z.strictObject({ version: z.literal(1), receipt: z.uuid() });

function refusal(status: number, code: string): Response {
  return Response.json({ error: { type: "model_unavailable", code } }, { status });
}

type PeerDial = (path: string, init: RequestInit) => Promise<Response>;

function dialFor(input: PeerColdClientInput): PeerDial | undefined {
  const { node } = input;
  const endpoint = URL.parse(node.endpoint);
  if (
    node.tunnelPreferred === true ||
    node.certificate === undefined ||
    node.certificateFingerprint === undefined ||
    node.name !== input.declaration.ownerNodeId ||
    endpoint?.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  )
    return undefined;
  const pinned = makePinnedFetch(node);
  return (path, init) => pinned(new URL(path, endpoint), init);
}

async function readReceipt(response: Response, signal: AbortSignal): Promise<string | undefined> {
  const text = await readPeerText(response, 1024, signal);
  if (text === undefined) return undefined;
  const parsed = receiptSchema.safeParse(JSON.parse(text) as unknown);
  return parsed.success ? parsed.data.receipt : undefined;
}

async function settlePeerReply(
  response: Response,
  stream: boolean,
  signal: AbortSignal,
): Promise<Response> {
  if (response.body === null || (stream && response.ok)) return response;
  const body = await readPeerText(response, 16 * 1024 * 1024, signal);
  if (body === undefined) return refusal(502, "peer_cold_outcome_unknown");
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(body, { status: response.status, headers });
}

export async function dispatchPinnedPeerCold(input: PeerColdClientInput): Promise<Response> {
  let submitted = false;
  try {
    const remaining = input.deadlineMs - Date.now();
    const dial = dialFor(input);
    if (remaining <= 0 || input.signal.aborted || dial === undefined) {
      return refusal(503, "peer_cold_owner_unavailable");
    }
    const completion = JSON.stringify(input.body);
    if (
      Buffer.byteLength(JSON.stringify({ receipt: crypto.randomUUID(), completion })) >
      PEER_COLD_MAX_BODY_BYTES
    ) {
      return refusal(413, "peer_cold_body_too_large");
    }
    const budgetMs = Math.min(remaining, 300_000);
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(budgetMs)]);
    const post = (stage: "resolve" | "execute", body: unknown): Promise<Response> =>
      dial(`${PEER_COLD_ROUTE}/${stage}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.serviceCredential}`,
        },
        body: JSON.stringify(body),
        signal,
        redirect: "error",
      });
    const result = await post("resolve", {
      version: 1,
      requestId: crypto.randomUUID(),
      owner: input.declaration.ownerNodeId,
      model: input.declaration.id,
      workload: input.declaration.workload,
      artifactRevision: input.declaration.artifactRevision,
      policyRevision: input.declaration.policyRevision,
      bodyDigest: peerColdBodyDigest(completion),
      budgetMs,
      path: input.path,
    });
    if (result.status === 429) return await settlePeerReply(result, false, signal);
    if (!result.ok) {
      void result.body?.cancel().catch(() => undefined);
      return refusal(503, "peer_cold_owner_unavailable");
    }
    const receipt = await readReceipt(result, signal);
    if (receipt === undefined || !(await input.stillSelected()) || signal.aborted) {
      return refusal(503, "peer_cold_owner_unavailable");
    }
    submitted = true;
    const response = await post("execute", { receipt, completion });
    return await settlePeerReply(response, input.body["stream"] === true, signal);
  } catch {
    return submitted
      ? refusal(502, "peer_cold_outcome_unknown")
      : refusal(503, "peer_cold_owner_unavailable");
  }
}
