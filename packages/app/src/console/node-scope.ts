// Per-tab node scope for the web console (#410 P3). Resolution order:
// ?node= → sessionStorage → nodeList.defaultNode (dispatchable) → "local".
// The name rule is the server's segment rule, re-exported from the HTTP
// transport so the transport owns it and this module keeps no console or
// React-side copy. Dispatchability mirrors validateConsoleNode in
// @llamactl/remote's console/node-route.ts. The store is keyed per tab
// through sessionStorage — never localStorage. A "Duplicate tab" copies
// sessionStorage: acceptable, because the duplicate starts on the same
// node and is independent afterwards.

import * as React from "react";

import { CONSOLE_NODE_NAME, isConsoleNodeName } from "../lib/transport/http";

export { CONSOLE_NODE_NAME, isConsoleNodeName };

export const TAB_NODE_STORAGE_KEY = "llamactl-console-node";

const LOCAL_INPROC_ENDPOINT = "inproc://local";
const LOCAL_FALLBACK_NODE = "local";

export interface ConsoleNodeEntry {
  name: string;
  endpoint?: string;
  effectiveKind?: string;
}

export interface ConsoleNodeList {
  defaultNode?: string;
  nodes: ConsoleNodeEntry[];
}

export interface StorageLike {
  readonly length: number;
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  key: (index: number) => string | null;
}

export type TabNodeSource = "url" | "storage" | "default" | "local";

export interface TabNodeRejection {
  from: "url" | "storage";
  name: string;
  reason: "invalid_name" | "not_dispatchable";
}

export interface TabNodeResolution {
  node: string;
  source: TabNodeSource;
  provisional?: true;
  rejected?: TabNodeRejection;
}

export interface ResolveTabNodeOptions {
  search: string;
  storage: StorageLike;
  nodeList: ConsoleNodeList | null;
}

export function dispatchableNodes(nodeList: ConsoleNodeList): ConsoleNodeEntry[] {
  return nodeList.nodes.filter(
    (entry) => entry.effectiveKind === "agent" || entry.endpoint === LOCAL_INPROC_ENDPOINT,
  );
}

type CandidateOutcome =
  | { kind: "none" }
  | { kind: "accept"; name: string; provisional: boolean }
  | { kind: "reject"; rejection: TabNodeRejection };

function evaluateCandidate(
  name: string | null,
  from: TabNodeRejection["from"],
  nodeList: ConsoleNodeList | null,
): CandidateOutcome {
  if (name === null || name === "") return { kind: "none" };
  if (!isConsoleNodeName(name)) {
    return { kind: "reject", rejection: { from, name, reason: "invalid_name" } };
  }
  if (nodeList === null) return { kind: "accept", name, provisional: true };
  const dispatchable = dispatchableNodes(nodeList).some((entry) => entry.name === name);
  if (!dispatchable) {
    return { kind: "reject", rejection: { from, name, reason: "not_dispatchable" } };
  }
  return { kind: "accept", name, provisional: false };
}

function readStorageNode(storage: StorageLike): string | null {
  try {
    return storage.getItem(TAB_NODE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readUrlNode(search: string): string | null {
  try {
    return new URLSearchParams(search).get("node");
  } catch {
    return null;
  }
}

export function resolveTabNode({
  search,
  storage,
  nodeList,
}: ResolveTabNodeOptions): TabNodeResolution {
  let rejected: TabNodeRejection | undefined;
  const withRejected = (resolution: TabNodeResolution): TabNodeResolution =>
    rejected === undefined ? resolution : { ...resolution, rejected };

  const fromUrl = evaluateCandidate(readUrlNode(search), "url", nodeList);
  if (fromUrl.kind === "accept") {
    return withRejected({
      node: fromUrl.name,
      source: "url",
      ...(fromUrl.provisional ? { provisional: true as const } : {}),
    });
  }
  if (fromUrl.kind === "reject") rejected = fromUrl.rejection;

  const fromStorage = evaluateCandidate(readStorageNode(storage), "storage", nodeList);
  if (fromStorage.kind === "accept") {
    return withRejected({
      node: fromStorage.name,
      source: "storage",
      ...(fromStorage.provisional ? { provisional: true as const } : {}),
    });
  }
  if (fromStorage.kind === "reject" && rejected === undefined) rejected = fromStorage.rejection;

  const defaultNode = nodeList?.defaultNode;
  if (
    nodeList !== null &&
    defaultNode !== undefined &&
    isConsoleNodeName(defaultNode) &&
    dispatchableNodes(nodeList).some((entry) => entry.name === defaultNode)
  ) {
    return withRejected({ node: defaultNode, source: "default" });
  }
  return withRejected({ node: LOCAL_FALLBACK_NODE, source: "local" });
}

export function persistTabNode(storage: StorageLike, node: string): void {
  if (!isConsoleNodeName(node)) {
    throw new Error(`invalid console node: ${JSON.stringify(node)}`);
  }
  storage.setItem(TAB_NODE_STORAGE_KEY, node);
}

const EMPTY_STORAGE: StorageLike = {
  length: 0,
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
  clear: () => undefined,
  key: () => null,
};

interface LocationLike {
  search: string;
}

interface HistoryLike {
  replaceState: (data: unknown, title: string, url?: string) => void;
}

export interface CreateTabNodeStoreOptions {
  location?: LocationLike;
  storage?: StorageLike;
}

export interface TabNodeStore {
  resolve: (nodeList: ConsoleNodeList | null) => TabNodeResolution;
  set: (node: string) => void;
}

export function createTabNodeStore(options: CreateTabNodeStoreOptions = {}): TabNodeStore {
  const currentSearch = (): string => {
    try {
      if (options.location !== undefined) return options.location.search;
      return (globalThis as { location?: LocationLike }).location?.search ?? "";
    } catch {
      return "";
    }
  };
  const currentStorage = (): StorageLike => {
    try {
      if (options.storage !== undefined) return options.storage;
      return (
        (globalThis as { sessionStorage?: StorageLike | null }).sessionStorage ?? EMPTY_STORAGE
      );
    } catch {
      return EMPTY_STORAGE;
    }
  };
  return {
    resolve: (nodeList: ConsoleNodeList | null): TabNodeResolution =>
      resolveTabNode({ search: currentSearch(), storage: currentStorage(), nodeList }),
    set: (node: string): void => {
      persistTabNode(currentStorage(), node);
      try {
        const history = (globalThis as { history?: HistoryLike }).history;
        if (history !== undefined) {
          const params = new URLSearchParams(currentSearch());
          params.set("node", node);
          history.replaceState(null, "", `?${params.toString()}`);
        }
      } catch {
        // Best effort: the persisted tab node is the source of truth.
      }
    },
  };
}

export interface UseTabNodeResult {
  node: string;
  setNode: (name: string) => void;
  options: ConsoleNodeEntry[];
  notice: TabNodeRejection | undefined;
}

export function useTabNode(nodeList: ConsoleNodeList | null): UseTabNodeResult {
  const store = React.useMemo(() => createTabNodeStore(), []);
  const [, bumpNodeRevision] = React.useState(0);
  const resolution = store.resolve(nodeList);

  const setNode = React.useCallback(
    (name: string) => {
      store.set(name);
      bumpNodeRevision((revision) => revision + 1);
    },
    [store],
  );

  return {
    node: resolution.node,
    setNode,
    options: dispatchableNodes(nodeList ?? { nodes: [] }),
    notice: resolution.rejected,
  };
}
