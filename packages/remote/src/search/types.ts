import type { SessionStatus } from '../ops-chat/sessions/list.js';

export interface MatchExcerpt {
  where: string;
  snippet: string;
  spans: { start: number; end: number }[];
}

export interface SessionHit {
  sessionId: string;
  goal: string;
  status: SessionStatus;
  startedAt: string;
  matches: MatchExcerpt[];
  /** Best score among the matches. */
  score: number;
}

export interface KnowledgeHit {
  entityId: string;
  title: string;
  matches: MatchExcerpt[];
  score: number;
}

export interface LogHit {
  fileLabel: string;     // e.g. 'ops-chat-audit', 'electron-main'
  filePath: string;
  matches: (MatchExcerpt & { lineNumber: number })[];
  score: number;
}

export interface GlobalSearchRagStatus {
  /** True iff at least one configured RAG node has the named collection. */
  sessions: boolean;
  knowledge: boolean;
  logs: boolean;
  /** The node id used for `ragSearch` calls, or null if no RAG node is configured. */
  defaultNode: string | null;
}
