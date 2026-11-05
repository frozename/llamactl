// Node-scoped provider pair for the web console (#410 P3). One
// QueryClient + tRPC client per tab node: switching the tab's node
// remounts the subtree through a keyed element, so a cached result from
// node A can never be served on node B. The node travels in the request
// URL via buildHttpLinks; there is no module-global node.

import type { ReactNode } from "react";

import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

import { createNodeScope } from "./create-node-scope";
import { ConsoleNodeContext, NodeTrpcProvider } from "./node-trpc";

export interface NodeScopedProviderProps {
  node: string;
  baseUrl?: string;
  children?: ReactNode;
}

export function NodeScopedProvider({
  node,
  baseUrl = "/api",
  children,
}: NodeScopedProviderProps): React.JSX.Element {
  const scope = React.useMemo(() => createNodeScope({ node, baseUrl }), [node, baseUrl]);
  return (
    <React.Fragment key={node}>
      <ConsoleNodeContext.Provider value={node}>
        <NodeTrpcProvider client={scope.client} queryClient={scope.queryClient}>
          <QueryClientProvider client={scope.queryClient}>{children}</QueryClientProvider>
        </NodeTrpcProvider>
      </ConsoleNodeContext.Provider>
    </React.Fragment>
  );
}
