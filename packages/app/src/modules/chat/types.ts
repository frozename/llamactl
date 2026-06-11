// packages/app/src/modules/chat/types.ts
export interface RetrievedDoc {
  id: string;
  score: number;
  contentPreview: string;
}

export interface RetrievedContext {
  sourceNode: string;
  docs: RetrievedDoc[];
  totalChars: number;
  truncated: boolean;
}

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "error";
  content: string;
  retrievedContext?: RetrievedContext;
}

export const CAPABILITY_TAGS = [
  "reasoning",
  "long_context",
  "tools",
  "vision",
  "json_mode",
  "code",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export interface CompareMeta {
  node: string;
  model: string;
  capabilities?: CapabilityTag[];
}

export interface Conversation {
  id: string;
  title: string;
  node: string;
  model: string;
  messages: Message[];
  capabilities?: CapabilityTag[];
  compareWith?: CompareMeta | null;
  messagesB?: Message[];
  ragNode?: string;
  ragTopK?: number;
}
