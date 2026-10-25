import type { MachineProfile } from "@llamactl/core";

export const PROFILES = [
  "mac-mini-16g",
  "balanced",
  "macbook-pro-48g",
  "large-128g",
] as const satisfies readonly MachineProfile[];
export const PRESETS = ["best", "vision", "balanced", "fast"] as const;
export type Profile = (typeof PROFILES)[number];
export type Preset = (typeof PRESETS)[number];

export type ClassFilter = "all" | "reasoning" | "multimodal" | "general" | "custom";
