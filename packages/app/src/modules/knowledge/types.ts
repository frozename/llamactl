// packages/app/src/modules/knowledge/types.ts
export type RagProviderKind = "chroma" | "pgvector";

export interface EmbedderBinding {
  node: string;
  model: string;
}

export type RagNodeSummary = {
  name: string;
  provider: RagProviderKind | null;
  kind: "rag";
  embedder: EmbedderBinding | null;
};

export interface AgentNodeSummary {
  name: string;
  endpoint: string;
}

export type TabId = "query" | "collections" | "indexing" | "pipelines" | "quality";

export interface SearchResultDoc {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  document: SearchResultDoc;
  score: number;
  distance?: number;
}

export interface SearchResponse {
  results: SearchResult[];
  collection: string;
}

export interface CollectionInfo {
  name: string;
  count?: number;
  dimensions?: number;
  metadata?: Record<string, unknown>;
}

export interface ListCollectionsResponse {
  collections: CollectionInfo[];
}

export interface StoreResponse {
  ids: string[];
  collection: string;
}

export interface IndexDocumentInput {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}
