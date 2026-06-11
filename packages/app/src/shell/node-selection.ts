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
  useEffect(() => {
    // Read the persisted selection imperatively: this is a one-shot
    // "reset to local on startup" migration, not a subscription —
    // re-running on selection changes would make selecting a node
    // impossible. After the first run the body is a no-op, so the
    // effect is idempotent if qc/utils ever change identity.
    const { selectedNode, setSelectedNode } = useNodeSelection.getState();
    if (selectedNode !== null) {
      setSelectedNode(null);
      void trpcUIClient.uiSetActiveNode.mutate({ name: "local" }).catch(() => {
        return undefined;
      });
      void utils.invalidate();
      void qc.invalidateQueries();
    }
  }, [qc, utils]);
}
