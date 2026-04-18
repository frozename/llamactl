import { decodeBootstrap } from '../config/agent-config.js';
import {
  consumeBootstrapToken,
  type ConsumeOptions,
} from '../config/bootstrap-tokens.js';
import {
  currentContext,
  loadConfig,
  saveConfig,
  upsertNode,
} from '../config/kubeconfig.js';
import type { ClusterNode } from '../config/schema.js';

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
  /** Optional override. When set, wins over the nodeName embedded in
   *  the bootstrap-token record. */
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
  'not-found': 401,
  expired: 410,
  'already-used': 409,
};

function jsonResponse(body: RegisterSuccessBody | RegisterFailureBody, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleRegister(
  req: Request,
  opts: RegisterHandlerOptions = {},
): Promise<Response> {
  if (req.method !== 'POST') {
    return jsonResponse({ ok: false, error: 'method not allowed' }, 405);
  }
  let payload: RegisterRequestBody;
  try {
    const raw = (await req.json()) as Record<string, unknown>;
    if (typeof raw.bootstrapToken !== 'string' || raw.bootstrapToken.length === 0) {
      return jsonResponse({ ok: false, error: 'bootstrapToken is required' }, 400);
    }
    if (typeof raw.blob !== 'string' || raw.blob.length === 0) {
      return jsonResponse({ ok: false, error: 'blob is required' }, 400);
    }
    payload = {
      bootstrapToken: raw.bootstrapToken,
      blob: raw.blob,
      ...(typeof raw.nodeName === 'string' ? { nodeName: raw.nodeName } : {}),
    };
  } catch {
    return jsonResponse({ ok: false, error: 'invalid JSON body' }, 400);
  }

  const consumeOpts: ConsumeOptions = {
    ...(opts.bootstrapTokensDir ? { dir: opts.bootstrapTokensDir } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  const consumed = consumeBootstrapToken(payload.bootstrapToken, consumeOpts);
  if (!consumed.ok) {
    const status = REASON_STATUS[consumed.reason] ?? 401;
    return jsonResponse(
      { ok: false, error: `bootstrap token ${consumed.reason}` },
      status,
    );
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

  const nodeName = payload.nodeName ?? consumed.record.nodeName;
  let cfg = loadConfig(opts.kubeconfigPath);
  const ctx = currentContext(cfg);

  cfg = {
    ...cfg,
    users: cfg.users.map((u) =>
      u.name === ctx.user ? { ...u, token: decoded.token } : u,
    ),
  };
  const entry: ClusterNode = {
    name: nodeName,
    endpoint: decoded.url,
    certificateFingerprint: decoded.fingerprint,
    certificate: decoded.certificate,
  };
  cfg = upsertNode(cfg, ctx.cluster, entry);
  saveConfig(cfg, opts.kubeconfigPath);

  return jsonResponse(
    {
      ok: true,
      nodeName,
      cluster: ctx.cluster,
      context: ctx.name,
    },
    200,
  );
}
