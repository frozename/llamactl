import type { ColdEngineDispatch } from "@llamactl/core/residency/engine-forwarder";

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { ColdOwnerAdmission } from "./cold-owner-admission.js";

import { extractBearer, namedBearerFor, type NamedBearerToken } from "../server/auth.js";

export const PEER_COLD_ROUTE = "/_llamactl/peer-cold/v1";
const RECEIPT_TTL_MS = 15_000;
export const PEER_COLD_MAX_BODY_BYTES = 1024 * 1024;
const MAX_PENDING = 32;
const MAX_ACCEPTED = 4096;
const MAX_PENDING_PER_GATEWAY = 8;
const MAX_ACCEPTED_PER_GATEWAY = 256;
const MAX_BUDGET_MS = 300_000;

const revisionDigest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const resolveSchema = z.strictObject({
  version: z.literal(1),
  requestId: z.uuid(),
  owner: z.string().min(1).max(128),
  model: z.string().min(1).max(512),
  workload: z.string().min(1).max(63),
  artifactRevision: revisionDigest,
  policyRevision: revisionDigest,
  bodyDigest: revisionDigest,
  path: z.literal("/v1/completions"),
  budgetMs: z.number().int().min(1).max(MAX_BUDGET_MS),
});
const executeSchema = z.strictObject({
  receipt: z.uuid(),
  completion: z.string().min(1).max(PEER_COLD_MAX_BODY_BYTES),
});
const completionSchema = z
  .looseObject({ model: z.string().min(1).max(512) })
  .refine((value) => !Object.hasOwn(value, "x_omlx_request_handle"));

export function peerColdBodyDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

type ResolveInput = z.output<typeof resolveSchema>;
type BoundDispatch = NonNullable<ReturnType<ColdOwnerAdmission["bindPeer"]>>;
type Declaration = ColdEngineDispatch["declaration"];

export interface PeerColdCredential extends NamedBearerToken {
  models: readonly string[];
}

interface PeerColdOptions {
  nodeName: string;
  credentials: readonly PeerColdCredential[];
  readDeclarations: () => readonly Declaration[];
  bind: ColdOwnerAdmission["bindPeer"];
  nowMs?: () => number;
}

interface Receipt {
  id: string;
  principal: string;
  fingerprint: string;
  input: ResolveInput;
  dispatch: BoundDispatch | undefined;
  issuedAt: number;
  issuedUntil: number;
  forgetAt: number;
}

function refuse(status: number, code: string): Response {
  return Response.json(
    { error: { type: "peer_cold", code } },
    {
      status,
      headers:
        status === 429
          ? { "cache-control": "no-store", "retry-after": "1" }
          : { "cache-control": "no-store" },
    },
  );
}

export async function readPeerText(
  source: Request | Response,
  limit: number,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (source.body === null) return undefined;
  signal.throwIfAborted();
  const reader = source.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) return undefined;
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) return undefined;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

async function readPeerBody(req: Request, limit: number): Promise<unknown> {
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5000)]);
  try {
    const body = await readPeerText(req, limit, signal);
    return body === undefined ? undefined : (JSON.parse(body) as unknown);
  } catch {
    return undefined;
  }
}

class PeerColdReceipts {
  private readonly byId = new Map<string, Receipt>();
  private readonly byRequest = new Map<string, Receipt>();

  prune(now: number): void {
    for (const [id, receipt] of this.byId) {
      if (receipt.forgetAt > now) continue;
      this.byId.delete(id);
      this.byRequest.delete(this.requestKey(receipt.principal, receipt.input.requestId));
    }
  }

  private requestKey(principal: string, requestId: string): string {
    return JSON.stringify([principal, requestId]);
  }

  private capacity(principal: string): boolean {
    if (this.byId.size >= MAX_ACCEPTED) return false;
    let ownRetained = 0;
    let ownPending = 0;
    let pending = 0;
    for (const row of this.byId.values()) {
      if (row.dispatch !== undefined) pending++;
      if (row.principal !== principal) continue;
      ownRetained++;
      if (row.dispatch !== undefined) ownPending++;
    }
    return (
      ownRetained < MAX_ACCEPTED_PER_GATEWAY &&
      ownPending < MAX_PENDING_PER_GATEWAY &&
      pending < MAX_PENDING
    );
  }

  resolve(
    principal: string,
    input: ResolveInput,
    resolveDispatch: () => BoundDispatch | undefined,
    now: number,
  ): Response {
    const key = this.requestKey(principal, input.requestId);
    const fingerprint = JSON.stringify(input);
    const previous = this.byRequest.get(key);
    if (previous !== undefined) {
      return previous.dispatch !== undefined && previous.fingerprint === fingerprint
        ? receiptResponse(previous)
        : refuse(409, "peer_request_already_used");
    }
    if (!this.capacity(principal)) return refuse(429, "peer_receipt_capacity");
    const dispatch = resolveDispatch();
    if (dispatch === undefined) return refuse(503, "peer_declaration_unverified");
    const id = randomUUID();
    const row = {
      id,
      principal,
      fingerprint,
      input,
      dispatch,
      issuedAt: now,
      issuedUntil: now + Math.min(RECEIPT_TTL_MS, input.budgetMs),
      forgetAt: now + Math.min(RECEIPT_TTL_MS, input.budgetMs),
    };
    this.byId.set(id, row);
    this.byRequest.set(key, row);
    return receiptResponse(row);
  }

  consume(
    principal: string,
    id: string,
    model: string,
    digest: string,
    now: number,
  ): { row: Receipt; dispatch: BoundDispatch } | undefined {
    const row = this.byId.get(id);
    if (
      row?.principal !== principal ||
      row.issuedUntil <= now ||
      row.dispatch === undefined ||
      row.input.model !== model ||
      row.input.bodyDigest !== digest
    )
      return undefined;
    const dispatch = row.dispatch;
    row.dispatch = undefined;
    row.forgetAt = now + MAX_BUDGET_MS + 60_000;
    return { row, dispatch };
  }
}

function receiptResponse(row: Receipt): Response {
  return Response.json(
    { version: 1, receipt: row.id },
    { headers: { "cache-control": "no-store" } },
  );
}

function resolvePeerDispatch(
  opts: PeerColdOptions,
  input: ResolveInput,
): BoundDispatch | undefined {
  const candidates = opts.readDeclarations().filter((item) => item.id === input.model);
  const [entry] = candidates;
  if (
    candidates.length !== 1 ||
    entry?.workload !== input.workload ||
    entry.ownerNodeId !== input.owner ||
    entry.kind !== "ModelRun"
  )
    return undefined;
  return opts.bind(entry, {
    artifactRevision: input.artifactRevision,
    policyRevision: input.policyRevision,
  });
}

function sendEngine(target: string, signal: AbortSignal, body?: string): Promise<Response> {
  return fetch(target, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body ?? null,
    signal,
    redirect: "error",
  });
}

function readAuthorizedResolve(
  input: unknown,
  opts: PeerColdOptions,
  credential: PeerColdCredential,
): ResolveInput | Response {
  const parsed = resolveSchema.safeParse(input);
  if (!parsed.success) return refuse(400, "peer_request_invalid");
  if (parsed.data.owner !== opts.nodeName || !credential.models.includes(parsed.data.model)) {
    return refuse(403, "peer_model_scope");
  }
  return parsed.data;
}

async function executeReceipt(
  req: Request,
  input: unknown,
  principal: string,
  receipts: PeerColdReceipts,
  now: number,
): Promise<Response> {
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) return refuse(400, "peer_request_invalid");
  const { receipt, completion } = parsed.data;
  let body: unknown;
  try {
    body = JSON.parse(completion) as unknown;
  } catch {
    return refuse(400, "peer_completion_invalid");
  }
  const content = completionSchema.safeParse(body);
  if (!content.success) return refuse(400, "peer_completion_invalid");
  const used = receipts.consume(
    principal,
    receipt,
    content.data.model,
    peerColdBodyDigest(completion),
    now,
  );
  if (used === undefined) return refuse(409, "peer_receipt_unavailable");
  try {
    const upstream = await used.dispatch({
      path: used.row.input.path,
      deadlineMs: Date.now() + used.row.input.budgetMs - (now - used.row.issuedAt),
      clientSignal: req.signal,
      principal: { service: "peer-cold", scope: principal },
      body: completion,
      send: sendEngine,
    });
    const headers = new Headers({ "cache-control": "no-store" });
    for (const name of ["content-type", "retry-after"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return refuse(502, "peer_outcome_unknown");
  }
}

function scopedCredentials(
  credentials: readonly PeerColdCredential[],
): Map<string, PeerColdCredential> {
  const out = new Map<string, PeerColdCredential>();
  const hashes = new Set<string>();
  for (const supplied of credentials) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(supplied.name) ||
      !/^[a-f0-9]{64}$/.test(supplied.tokenHash) ||
      supplied.models.length === 0 ||
      out.has(supplied.name) ||
      hashes.has(supplied.tokenHash)
    ) {
      throw new Error("InvalidPeerColdCredentials");
    }
    hashes.add(supplied.tokenHash);
    out.set(supplied.name, { ...supplied, models: [...supplied.models] });
  }
  return out;
}

export function createPeerColdHandler(opts: PeerColdOptions): (req: Request) => Promise<Response> {
  const credentials = scopedCredentials(opts.credentials);
  const bindings = [...credentials.values()];
  const receipts = new PeerColdReceipts();
  const nowMs = opts.nowMs ?? ((): number => performance.now());
  let bodyReaders = 0;

  return async (req): Promise<Response> => {
    const url = new URL(req.url);
    const resolve = url.pathname === `${PEER_COLD_ROUTE}/resolve`;
    if (
      url.protocol !== "https:" ||
      url.search !== "" ||
      req.method !== "POST" ||
      (!resolve && url.pathname !== `${PEER_COLD_ROUTE}/execute`)
    )
      return refuse(404, "peer_protocol_unavailable");
    const principal = namedBearerFor(extractBearer(req), bindings);
    const allowed = principal === null ? undefined : credentials.get(principal);
    if (allowed === undefined) return refuse(401, "peer_credential_required");
    if (bodyReaders >= MAX_PENDING) return refuse(429, "peer_body_capacity");

    bodyReaders++;
    let input: unknown;
    try {
      input = await readPeerBody(req, resolve ? 4096 : PEER_COLD_MAX_BODY_BYTES);
    } finally {
      bodyReaders--;
    }
    const now = nowMs();
    receipts.prune(now);
    if (!resolve) return await executeReceipt(req, input, allowed.name, receipts, now);
    const parsed = readAuthorizedResolve(input, opts, allowed);
    return parsed instanceof Response
      ? parsed
      : receipts.resolve(allowed.name, parsed, () => resolvePeerDispatch(opts, parsed), now);
  };
}
