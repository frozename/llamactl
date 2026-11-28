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

let installed: LocalEngineForwarder | undefined;

export function getLocalEngineForwarder(): LocalEngineForwarder | undefined {
  return installed;
}

export function installLocalEngineForwarder(forwarder: LocalEngineForwarder): () => void {
  if (installed !== undefined) throw new Error("local engine admission is already installed");
  installed = forwarder;
  return (): void => {
    if (installed === forwarder) installed = undefined;
  };
}
