import type { DeclaredModelEntryV1 } from "../routing/catalog.js";

/** Process-scoped admission hook for the HTTP proxy and local tRPC engine client. */
export interface LocalEngineRequest {
  target: string;
  deadlineMs: number;
  body: string | null;
  workload?: string;
  /** Published only for the verified llama.cpp HTTP completion target. */
  pretokenizedCompletion?: true;
  clientSignal: AbortSignal;
  engineSignal?: AbortSignal;
  stillOwnsTarget?: () => boolean;
  principal: { bearer: string | null } | { service: string; scope: string };
}

export interface LocalEngineDispatch extends LocalEngineRequest {
  send: (signal: AbortSignal, body?: string, transport?: typeof fetch) => Promise<Response>;
}

export function withLocalEngineBody(init: RequestInit, body: string | undefined): RequestInit {
  if (body === undefined) return init;
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  return { ...init, headers, body };
}

export interface ColdEngineDispatch {
  declaration: DeclaredModelEntryV1;
  path: "/v1/chat/completions" | "/v1/completions";
  deadlineMs: number;
  body: string | null;
  clientSignal: AbortSignal;
  principal: LocalEngineRequest["principal"];
  send: (
    target: string,
    signal: AbortSignal,
    body?: string,
    transport?: typeof fetch,
  ) => Promise<Response>;
}

export type ColdEngineForwarder = (request: ColdEngineDispatch) => Promise<Response>;

export type LocalEngineForwarder = (dispatch: LocalEngineDispatch) => Promise<Response> | undefined;

export type SelectLocalEngineReadiness = (
  route: { workload: string; host: string; port: number; requiresOwnerTransport?: true },
  path: string,
) => typeof fetch | null | undefined;

let installed:
  | { forward: LocalEngineForwarder; readiness?: SelectLocalEngineReadiness }
  | undefined;

export function getLocalEngineForwarder(): LocalEngineForwarder | undefined {
  return installed?.forward;
}

export function selectLocalEngineReadiness(
  route: Parameters<SelectLocalEngineReadiness>[0],
  path: string,
): ReturnType<SelectLocalEngineReadiness> {
  try {
    const selected = installed?.readiness?.(route, path);
    return selected === undefined && route.requiresOwnerTransport === true ? null : selected;
  } catch {
    return null;
  }
}

export function installLocalEngineForwarder(
  forward: LocalEngineForwarder,
  readiness?: SelectLocalEngineReadiness,
): () => void {
  if (installed !== undefined) throw new Error("local engine admission is already installed");
  const entry = { forward, ...(readiness === undefined ? {} : { readiness }) };
  installed = entry;
  return (): void => {
    if (installed === entry) installed = undefined;
  };
}
