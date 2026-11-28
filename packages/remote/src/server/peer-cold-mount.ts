import { openaiProxy } from "@llamactl/core";

import type { ColdOwnerAdmission } from "../residency/cold-owner-admission.js";
import type { StartAgentOptions } from "./serve.js";

import { createPeerColdHandler } from "../residency/peer-cold.js";
import { LOCAL_NODE_ID } from "../workload/modelhost-schema.js";
import { extractBearer, namedBearerFor, unauthorizedResponse } from "./auth.js";

function privilegedCredentialHashes(opts: StartAgentOptions): Set<string> {
  const hashes = [
    opts.tokenHash,
    ...(opts.bearerTokens?.() ?? []).map((entry) => entry.tokenHash),
    ...(opts.workerRpc?.settings()?.serviceCredentials ?? []).map((entry) => entry.tokenHash),
    ...(opts.tunnelCentral?.workerRpcRelay?.()?.tokenHashes ?? []),
    opts.tunnelCentral?.expectedBearerHash,
  ];
  return new Set(hashes.filter((hash) => hash !== undefined));
}

export function preparePeerColdHandler(
  opts: StartAgentOptions,
  nodeName: string,
  cold: ColdOwnerAdmission | undefined,
):
  | {
      handle: ReturnType<typeof createPeerColdHandler>;
      isCredential: (req: Request) => boolean;
    }
  | undefined {
  const credentials = opts.managedPeerColdCredentials?.map((entry) => ({
    ...entry,
    models: [...entry.models],
  }));
  if (credentials === undefined || credentials.length === 0) return undefined;
  if (
    opts.tls === undefined ||
    opts.noAuth === true ||
    cold === undefined ||
    opts.managedLaunchAdmission?.ownerNodeId !== nodeName
  ) {
    throw new Error("ManagedPeerColdOwnerRequired");
  }
  const isDistinct = (): boolean => {
    const privileged = privilegedCredentialHashes(opts);
    return credentials.every((entry) => !privileged.has(entry.tokenHash));
  };
  if (!isDistinct()) throw new Error("ManagedPeerColdCredentialConflict");
  const handle = createPeerColdHandler({
    nodeName,
    credentials,
    readDeclarations: () =>
      openaiProxy
        .validatedDeclaredModelEntries()
        .filter((entry) => entry.ownerNodeId === LOCAL_NODE_ID)
        .map((entry) => ({ ...entry, ownerNodeId: nodeName })),
    bind: (entry, revision) => cold.bindPeer({ ...entry, ownerNodeId: LOCAL_NODE_ID }, revision),
  });
  return {
    handle: (req) => (isDistinct() ? handle(req) : Promise.resolve(unauthorizedResponse())),
    isCredential: (req) => namedBearerFor(extractBearer(req), credentials) !== null,
  };
}
