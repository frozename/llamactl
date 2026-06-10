import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { trpc, trpcUIClient } from "@/lib/trpc";

interface NodeSelectionStore {
  selectedNode: string | null;
  setSelectedNode: (name: string | null) => void;
}

export const useNodeSelection = create<NodeSelectionStore>()(
  persist(
    (set) => ({
      selectedNode: null,
      setSelectedNode: (name): void => void set({ selectedNode: name }),
    }),
    { name: "llamactl-node-selection" },
  ),
);

export function useSyncActiveNode(): void {
  const qc = useQueryClient();
  const utils = trpc.useUtils();
  const { selectedNode, setSelectedNode } = useNodeSelection();
  useEffect(() => {
    if (selectedNode !== null) {
      setSelectedNode(null);
      void trpcUIClient.uiSetActiveNode.mutate({ name: "local" }).catch(() => {
        return undefined;
      });
      void utils.invalidate();
      void qc.invalidateQueries();
    }
  }, []);
}
