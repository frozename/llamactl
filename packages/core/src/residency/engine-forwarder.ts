/** Process-scoped admission hook for the HTTP proxy and local tRPC engine client. */
export interface LocalEngineRequest {
  target: string;
  deadlineMs: number;
  body: string | null;
  workload?: string;
  clientSignal: AbortSignal;
  engineSignal?: AbortSignal;
  stillOwnsTarget?: () => boolean;
  principal: { bearer: string | null } | { service: string; scope: string };
}

export interface LocalEngineDispatch extends LocalEngineRequest {
  send: (signal: AbortSignal) => Promise<Response>;
}

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
