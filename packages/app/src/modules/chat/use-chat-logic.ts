import { trpc } from "@/lib/trpc";

import type { CapabilityTag, Message, RetrievedContext, RetrievedDoc } from "./types";

import { useChatStore } from "./store";

const MAX_CONTEXT_CHARS = 12000;
const CONTENT_PREVIEW_CHARS = 200;

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string }[];
  providerOptions?: { capabilities: CapabilityTag[] };
  [key: string]: unknown;
}

export interface UseChatActionsResult {
  retrieveContext: (
    ragNode: string,
    query: string,
    topK: number,
  ) => Promise<{
    systemMessage: { role: "system"; content: string };
    metadata: RetrievedContext;
  } | null>;
  buildRequest: (
    history: Message[],
    text: string,
    model: string,
    capabilities: CapabilityTag[],
    contextMessage?: { role: "system"; content: string },
  ) => ChatRequest;
}

export function useChatActions(): UseChatActionsResult {
  const store = useChatStore();
  const utils = trpc.useUtils();
  void store;

  async function retrieveContext(
    ragNode: string,
    query: string,
    topK: number,
  ): Promise<{
    systemMessage: { role: "system"; content: string };
    metadata: RetrievedContext;
  } | null> {
    try {
      const response = await utils.ragSearch.fetch({ node: ragNode, query, topK });
      const hits = response.results;
      if (hits.length === 0) return null;
      const header = `Relevant context from knowledge base "${ragNode}":`;
      const parts: string[] = [header];
      const attachedDocs: RetrievedDoc[] = [];
      let used = header.length;
      let truncated = false;
      for (const hit of hits) {
        const body = hit.document.content;
        const chunk = `--- doc ${hit.document.id} (score=${hit.score.toFixed(3)}) ---\n${body}`;
        if (used + chunk.length + 2 > MAX_CONTEXT_CHARS) {
          truncated = true;
          break;
        }
        parts.push(chunk);
        used += chunk.length + 2;
        attachedDocs.push({
          id: hit.document.id,
          score: hit.score,
          contentPreview: body.slice(0, CONTENT_PREVIEW_CHARS),
        });
      }
      if (attachedDocs.length === 0) return null;
      return {
        systemMessage: { role: "system", content: parts.join("\n\n") },
        metadata: { sourceNode: ragNode, docs: attachedDocs, totalChars: used, truncated },
      };
    } catch {
      return null;
    }
  }

  function buildRequest(
    history: Message[],
    text: string,
    model: string,
    capabilities: CapabilityTag[],
    contextMessage?: { role: "system"; content: string },
  ): ChatRequest {
    const priorTurns = history.filter((m) => m.role === "user" || m.role === "assistant");
    return {
      model,
      messages: [
        ...(contextMessage ? [contextMessage] : []),
        ...priorTurns,
        { role: "user", content: text },
      ].map((m) => ({ role: m.role, content: m.content })),
      ...(capabilities.length > 0 ? { providerOptions: { capabilities } } : {}),
    };
  }

  return { retrieveContext, buildRequest };
}
