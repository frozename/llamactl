import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CapabilityTag, Pipeline, Stage } from "./types";

interface PipelinesStore {
  pipelines: Record<string, Pipeline>;
  activeId: string | null;
  create: (init: { node: string; model: string }) => string;
  setActive: (id: string) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  addStage: (id: string, stage: Stage) => void;
  updateStage: (id: string, stageId: string, patch: Partial<Stage>) => void;
  removeStage: (id: string, stageId: string) => void;
  toggleStageCapability: (id: string, stageId: string, tag: CapabilityTag) => void;
}

export const usePipelinesStore = create<PipelinesStore>()(
  persist(
    (set) => ({
      pipelines: {},
      activeId: null,
      create: ({ node, model }): string => {
        const id = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        set((s) => ({
          pipelines: {
            ...s.pipelines,
            [id]: {
              id,
              name: "New pipeline",
              stages: [
                {
                  id: `s-${Date.now().toString(36)}`,
                  node,
                  model,
                  systemPrompt: "",
                  capabilities: [],
                },
              ],
            },
          },
          activeId: id,
        }));
        return id;
      },
      setActive: (id): void => void set({ activeId: id }),
      rename: (id, name): void =>
        void set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return { pipelines: { ...s.pipelines, [id]: { ...p, name } } };
        }),
      remove: (id): void =>
        void set((s) => {
          const rest = Object.fromEntries(
            Object.entries(s.pipelines).filter(([key]) => key !== id),
          );
          const ids = Object.keys(rest);
          return {
            pipelines: rest,
            activeId: s.activeId === id ? (ids[0] ?? null) : s.activeId,
          };
        }),
      addStage: (id, stage): void =>
        void set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: { ...s.pipelines, [id]: { ...p, stages: [...p.stages, stage] } },
          };
        }),
      updateStage: (id, stageId, patch): void =>
        void set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: {
                ...p,
                stages: p.stages.map((st) => (st.id === stageId ? { ...st, ...patch } : st)),
              },
            },
          };
        }),
      removeStage: (id, stageId): void =>
        void set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: { ...p, stages: p.stages.filter((st) => st.id !== stageId) },
            },
          };
        }),
      toggleStageCapability: (id, stageId, tag): void =>
        void set((s) => {
          const p = s.pipelines[id];
          if (!p) return s;
          return {
            pipelines: {
              ...s.pipelines,
              [id]: {
                ...p,
                stages: p.stages.map((st) => {
                  if (st.id !== stageId) return st;
                  const has = st.capabilities.includes(tag);
                  return {
                    ...st,
                    capabilities: has
                      ? st.capabilities.filter((t) => t !== tag)
                      : [...st.capabilities, tag],
                  };
                }),
              },
            },
          };
        }),
    }),
    { name: "llamactl-pipelines" },
  ),
);
