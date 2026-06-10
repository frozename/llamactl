import { create } from "zustand";
import { persist } from "zustand/middleware";

interface WorkloadSelectionStore {
  selected: string | null;
  setSelected: (name: string | null) => void;
}

export const useWorkloadSelectionStore = create<WorkloadSelectionStore>()(
  persist(
    (set) => ({
      selected: null,
      setSelected: (name) => set({ selected: name }),
    }),
    { name: "beacon-workload-selection", version: 1 },
  ),
);
