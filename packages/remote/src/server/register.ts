import type { ClusterNode, Config } from "@llamactl/core/config/schema";

import { decodeBootstrap } from "@llamactl/core/config/agent-config";
import {
  assertTokenReplaceable,
  currentContext,
  defaultConfigPath,
  mutateConfig,
  TokenConflictError,
  upsertNode,
} from "@llamactl/core/config/kubeconfig";

import { consumeBootstrapToken, type ConsumeOptions } from "../config/bootstrap-tokens.js";

const mutateConfigLocked = (path: string, fn: (cfg: Config) => Config): Config =>
  mutateConfig(path, fn);

/**
 * HTTP handler for POST /register. Unauthenticated by design —
 * nodes have no bearer yet; that's what this endpoint is for. The
 * request body carries:
 *
 *   * bootstrapToken — plaintext, minted by `llamactl deploy-node`.
 *   * blob           — same base64url bootstrap blob shape the
 *                      existing `llamactl node add --bootstrap` flow
 *                      already consumes: { url, fingerprint, token,
 *                      certificate }.
 *
 * On success we consume the bootstrap token (single-use, expiry
 * enforced), decode the blob, and write the node into the current
 * context's cluster — same kubeconfig-mutation logic tRPC's
 * `nodeAdd` uses, minus the bearer-protected path. Token consumption
 * is atomic vs. concurrent requests because file writes are
 * last-writer-wins; a second caller with the same plaintext sees
 * `already-used`.
 *
 * Factored into its own module so the handler stays testable
 * without a full Bun.serve, and so the register-flow changes don't
 * touch serve.ts on every iteration.
 */

export interface RegisterHandlerOptions {
  /** Override the bootstrap-tokens directory (tests). */
  bootstrapTokensDir?: string;
  /** Override the kubeconfig path (tests). */
  kubeconfigPath?: string;
  /** Clock injection (tests). */
  now?: () => Date;
}

interface RegisterRequestBody {
  bootstrapToken: string;
  blob: string;
  /** Optional echo. When present, must equal the nodeName embedded
   *  in the bootstrap-token record; mismatches are rejected. The
   *  token record's nodeName is always authoritative. */
  nodeName?: string;
}

interface RegisterSuccessBody {
  ok: true;
  nodeName: string;
  cluster: string;
  context: string;
}

interface RegisterFailureBody {
  ok: false;
  error: string;
}

const REASON_STATUS: Record<string, number> = {
  "not-found": 401,
  expired: 410,
  "already-used": 409,
};

function jsonResponse(body: RegisterSuccessBody | RegisterFailureBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type ParsedRegisterPayload = { payload: RegisterRequestBody } | { response: Response };

async function parseRegisterPayload(req: Request): Promise<ParsedRegisterPayload> {
  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return { response: jsonResponse({ ok: false, error: "invalid JSON body" }, 400) };
  }
  if (typeof raw["bootstrapToken"] !== "string" || raw["bootstrapToken"].length === 0) {
    return { response: jsonResponse({ ok: false, error: "bootstrapToken is required" }, 400) };
  }
  if (typeof raw["blob"] !== "string" || raw["blob"].length === 0) {
    return { response: jsonResponse({ ok: false, error: "blob is required" }, 400) };
  }
  return {
    payload: {
      bootstrapToken: raw["bootstrapToken"],
      blob: raw["blob"],
      ...(typeof raw["nodeName"] === "string" ? { nodeName: raw["nodeName"] } : {}),
    },
  };
}

export async function handleRegister(
  req: Request,
  opts: RegisterHandlerOptions = {},
): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method not allowed" }, 405);
  }
  const parsed = await parseRegisterPayload(req);
  if ("response" in parsed) return parsed.response;
  const payload = parsed.payload;

  const consumeOpts: ConsumeOptions = {
    ...(opts.bootstrapTokensDir ? { dir: opts.bootstrapTokensDir } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  const consumed = consumeBootstrapToken(payload.bootstrapToken, consumeOpts);
  if (!consumed.ok) {
    const status = REASON_STATUS[consumed.reason] ?? 401;
    return jsonResponse({ ok: false, error: `bootstrap token ${consumed.reason}` }, status);
  }

  let decoded: ReturnType<typeof decodeBootstrap>;
  try {
    decoded = decodeBootstrap(payload.blob);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: `bootstrap blob invalid: ${(err as Error).message}` },
      400,
    );
  }

  // A bootstrap token authorizes registration of exactly the node
  // it was minted for. Letting the caller pass a different nodeName
  // would let any token holder upsert under an arbitrary name —
  // including an existing node's — silently overwriting its
  // endpoint/certificate and hijacking its traffic. Reject the
  // mismatch fail-closed; the token record is authoritative.
  if (payload.nodeName !== undefined && payload.nodeName !== consumed.record.nodeName) {
    return jsonResponse(
      { ok: false, error: "nodeName does not match bootstrap token record" },
      403,
    );
  }
  const nodeName = consumed.record.nodeName;
  const cfgPath = opts.kubeconfigPath ?? defaultConfigPath();
  let clusterName = "";
  let contextName = "";
  try {
    const names = writeRegistration(cfgPath, nodeName, decoded);
    clusterName = names.cluster;
    contextName = names.context;
  } catch (err) {
    if (!(err instanceof TokenConflictError)) throw err;
    return jsonResponse({ ok: false, error: err.message }, 409);
  }

  return jsonResponse(
    {
      ok: true,
      nodeName,
      cluster: clusterName,
      context: contextName,
    },
    200,
  );
}

function writeRegistration(
  cfgPath: string,
  nodeName: string,
  decoded: ReturnType<typeof decodeBootstrap>,
): { cluster: string; context: string } {
  const next = mutateConfigLocked(cfgPath, (cfg: Config) => {
    const ctx = currentContext(cfg);
    // The bootstrap token has authenticated the caller by this point.
    // Replacing the shared user bearer would cut off the cluster's
    // other agent nodes; there is no override on this endpoint.
    assertTokenReplaceable(cfg, ctx.cluster, ctx.user, decoded.token, nodeName);
    const withUser = {
      ...cfg,
      users: cfg.users.map((u) => (u.name === ctx.user ? { ...u, token: decoded.token } : u)),
    };
    const entry: ClusterNode = {
      name: nodeName,
      endpoint: decoded.url,
      certificateFingerprint: decoded.fingerprint,
      certificate: decoded.certificate,
    };
    return upsertNode(withUser, ctx.cluster, entry);
  });
  const ctx = currentContext(next);
  return { cluster: ctx.cluster, context: ctx.name };
}
