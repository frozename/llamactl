export const PROFILES = ["mac-mini-16g", "balanced", "macbook-pro-48g"] as const;
export const PRESETS = ["best", "vision", "balanced", "fast"] as const;
export type Profile = (typeof PROFILES)[number];
export type Preset = (typeof PRESETS)[number];

export type ClassFilter = "all" | "reasoning" | "multimodal" | "general" | "custom";
