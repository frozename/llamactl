// #410 P5a-3a, console node-scoped tRPC hooks: the single seam through
// which console code reaches the tab's tRPC client. The import guard in
// eslint.config.mjs bans the module-global `trpc` / `trpcUIClient` under
// src/console so no call site can silently use the global client instead
// of the node-scoped one installed by NodeScopedProvider; this wrapper is
// the one file the guard exempts, and it funnels every access through
// useConsoleNode(). Relative imports only, so bun tests can load it.

import * as React from "react";

import { trpc } from "../lib/trpc";

export const ConsoleNodeContext = React.createContext<string | null>(null);

export const NodeTrpcProvider: typeof trpc.Provider = trpc.Provider;

export function useConsoleNode(): string {
  const node = React.useContext(ConsoleNodeContext);
  if (node === null) {
    throw new Error("console hooks must be used inside NodeScopedProvider");
  }
  return node;
}

export function useNodeTrpc(): typeof trpc {
  useConsoleNode();
  return trpc;
}

export function useNodeTrpcUtils(): ReturnType<typeof trpc.useUtils> {
  useConsoleNode();
  return trpc.useUtils();
}
