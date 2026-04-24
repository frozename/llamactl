import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Shared executor config for the Ops Console (Ops Chat + Planner
 * tabs). The planner backend resolves `nodeId` via the fleet's
 * provider factory — no baseUrl/apiKey in the UI, since every
 * executable node already carries that binding. When no node is
 * picked yet, the picker surfaces it as an empty state.
 */
interface OpsExecutorStore {
  nodeId: string | null;
  model: string | null;
  setNode: (nodeId: string | null) => void;
  setModel: (model: string | null) => void;
}

export const useOpsExecutorStore = create<OpsExecutorStore>()(
  persist(
    (set) => ({
      nodeId: null,
      model: null,
      setNode: (nodeId) => set({ nodeId, model: null }),
      setModel: (model) => set({ model }),
    }),
    { name: 'llamactl-ops-executor' },
  ),
);
