export interface ProjectManifest {
  apiVersion: string;
  kind: string;
  metadata: { name: string };
  spec: {
    path: string;
    purpose?: string;
    stack?: string[];
    rag?: {
      node: string;
      collection: string;
      docsGlob?: string;
      schedule?: string;
    };
    routing?: Record<string, string>;
    budget?: {
      usd_per_day?: number;
      cli_calls_per_day?: Record<string, number>;
    };
  };
}

export interface ProjectListResponse {
  ok: true;
  projects: ProjectManifest[];
}

export interface RoutingDecision {
  ts: string;
  project: string;
  taskKind: string;
  target: string;
  matched: boolean;
  reason: "matched" | "fallback-default" | "project-not-found" | "over-budget";
  budget?: { usdToday?: number; limit?: number };
}

export interface JournalResponse {
  ok: true;
  path: string;
  entries: RoutingDecision[];
}

export interface RoutePreviewResponse {
  ok: true;
  node: string;
  decision: RoutingDecision | null;
}

export interface DetectedRepo {
  path: string;
  name: string;
  mtimeMs: number;
}
