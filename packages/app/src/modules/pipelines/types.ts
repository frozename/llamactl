export const CAPABILITY_TAGS = [
  "reasoning",
  "long_context",
  "tools",
  "vision",
  "json_mode",
  "code",
] as const;
export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface Stage {
  id: string;
  node: string;
  model: string;
  systemPrompt: string;
  capabilities: CapabilityTag[];
}

export interface Pipeline {
  id: string;
  name: string;
  stages: Stage[];
}
