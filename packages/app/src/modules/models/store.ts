import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ScopeFilter = "all" | "builtin" | "custom";

interface ModelsStore {
  scope: ScopeFilter;
  setScope: (s: ScopeFilter) => void;
}

export const useModelsStore = create<ModelsStore>()(
  persist(
    (set) => ({
      scope: "all",
      setScope: (s) => set({ scope: s }),
    }),
    { name: "llamactl-models" },
  ),
);
