import * as React from 'react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { Badge, Button, StatusDot, Input, Kbd } from '@/ui';
import { PipelinesTab } from './pipelines-tab';
import { QualityTab } from './quality-tab';

/**
 * Knowledge module. First UI consumer of the RAG stack shipped in
 * Phase 4 (`ragSearch`, `ragStore`, `ragDelete`, `ragListCollections`
 * on the base tRPC router). Walks the `RetrievalProvider` methods in
 * a three-tab shape: Query / Collections / Indexing.
 *
 * The node picker is hoisted to the module root so the three tabs
 * share a single `nodeList` fetch. We never surface the node's
 * `endpoint` (could leak a Postgres URL with credentials) — only
 * `name`, `provider`, and `kind` are operator-safe.
 *
 * File upload with chunking is intentionally deferred to a follow-up
 * slice (see rag-nodes.md § "Follow-up slices"). v1 ships a plain
 * JSON / paragraph text area.
 */

type RagProviderKind = 'chroma' | 'pgvector';

interface EmbedderBinding {
  node: string;
  model: string;
}

type RagNodeSummary = {
  name: string;
  provider: RagProviderKind | null;
  kind: 'rag';
  embedder: EmbedderBinding | null;
};

interface AgentNodeSummary {
  name: string;
  endpoint: string;
}

type TabId = 'query' | 'collections' | 'indexing' | 'pipelines' | 'quality';

interface SearchResultDoc {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

interface SearchResult {
  document: SearchResultDoc;
  score: number;
  distance?: number;
}

interface SearchResponse {
  results: SearchResult[];
  collection: string;
}

interface CollectionInfo {
  name: string;
  count?: number;
  dimensions?: number;
  metadata?: Record<string, unknown>;
}

interface ListCollectionsResponse {
  collections: CollectionInfo[];
}

interface StoreResponse {
  ids: string[];
  collection: string;
}

interface IndexDocumentInput {
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Format a cosine-similarity score (0..1) as a percentage string. */
function formatScore(score: number): string {
  const clamped = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  return `${(clamped * 100).toFixed(1)}%`;
}

/** Classify score into a Tailwind badge palette matching the project conventions. */
function scoreBadgeClass(score: number): string {
  if (!Number.isFinite(score)) {
    return 'bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]';
  }
  if (score >= 0.75) {
    return 'bg-[var(--color-brand)] text-[color:var(--color-brand-contrast)]';
  }
  if (score >= 0.45) {
    return 'bg-[var(--color-warn,var(--color-ok))] text-[color:var(--color-text-inverse)]';
  }
  return 'bg-[var(--color-surface-2)] text-[color:var(--color-text-secondary)]';
}

function truncateContent(content: string, max = 300): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max).trimEnd()}…`;
}

/**
 * Parse the Indexing tab's free-form input.
 *
 *   - If the trimmed text starts with `[`, treat as JSON array; each
 *     entry must carry `id` + `content` (metadata is optional).
 *   - Otherwise split on blank lines (`\n\n`), one paragraph per doc,
 *     auto-generating `doc-<8-char-uuid>` IDs.
 */
function parseIndexInput(raw: string): {
  documents: IndexDocumentInput[];
  error: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { documents: [], error: 'Input is empty.' };

  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      return {
        documents: [],
        error: `Invalid JSON: ${(err as Error).message}`,
      };
    }
    if (!Array.isArray(parsed)) {
      return {
        documents: [],
        error: 'JSON input must be an array of {id, content, metadata?} objects.',
      };
    }
    const docs: IndexDocumentInput[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const entry = parsed[i];
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as { id?: unknown }).id !== 'string' ||
        typeof (entry as { content?: unknown }).content !== 'string'
      ) {
        return {
          documents: [],
          error: `Entry [${i}] must have string 'id' and string 'content' fields.`,
        };
      }
      const e = entry as {
        id: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
      docs.push({
        id: e.id,
        content: e.content,
        metadata:
          e.metadata && typeof e.metadata === 'object' ? e.metadata : undefined,
      });
    }
    if (docs.length === 0) {
      return { documents: [], error: 'JSON array is empty.' };
    }
    return { documents: docs, error: null };
  }

  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) {
    return { documents: [], error: 'No paragraphs found.' };
  }
  const docs: IndexDocumentInput[] = paragraphs.map((content) => {
    const uuid =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return { id: `doc-${uuid}`, content };
  });
  return { documents: docs, error: null };
}

/**
 * Query tab. Runs a single `ragSearch` on submit. Uses the
 * `trpc.useUtils()` imperative fetcher (same pattern as workloads /
 * nodes / bench) because the procedure is a tRPC `.query` and we
 * want to assemble the input at submit time rather than binding it
 * to hook-render order.
 */
/**
 * Collection header — shows count / dimensions / embedder for the
 * currently-targeted collection so the operator can see, BEFORE
 * running a query, whether the collection is empty, what embedder
 * produced the vectors, and whether the pgvector binding is missing
 * its embedder (queries will fail otherwise). Surfaces CollectionInfo
 * fields that the Collections tab already shows in a table form but
 * were invisible from the Query tab.
 */
function CollectionHeader(props: {
  nodeName: string;
  collection: string;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element | null {
  const { nodeName, collection, embedder, provider } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );
  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];
  // Targeted collection: explicit `collection` if matches a row, else
  // the first collection the node reports (matches the node-default
  // adapters fall back to on search).
  const targeted = collection.trim()
    ? rows.find((c) => c.name === collection.trim()) ?? null
    : rows[0] ?? null;
  if (list.isLoading) {
    return (
      <div
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}
        data-testid="knowledge-collection-header"
      >
        Loading collection info…
      </div>
    );
  }
  if (list.error) {
    return null;
  }
  if (!targeted) {
    return (
      <div
        style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}
        data-testid="knowledge-collection-header"
      >
        No collection picked yet — switch to the Collections tab to see what's
        available on <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{nodeName}</Badge>.
      </div>
    );
  }
  const count = typeof targeted.count === 'number' ? targeted.count : null;
  const dims = typeof targeted.dimensions === 'number' ? targeted.dimensions : null;
  const warnings: string[] = [];
  if (count === 0) {
    warnings.push(
      'collection is empty — index documents in the Indexing tab before querying',
    );
  }
  if (!embedder && provider === 'pgvector') {
    warnings.push(
      'no embedder bound on this pgvector node — queries will fail. Bind one in the panel above.',
    );
  }
  const metaEntries = targeted.metadata
    ? Object.entries(targeted.metadata as Record<string, unknown>)
    : [];
  return (
    <div
      style={{ marginTop: 8, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
      data-testid="knowledge-collection-header"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 16, rowGap: 4, color: 'var(--color-text-secondary)', fontSize: 12 }}>
        <span>
          collection{' '}
          <span
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            data-testid="knowledge-collection-name"
          >
            {targeted.name}
          </span>
        </span>
        <span>
          count{' '}
          <span
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            data-testid="knowledge-collection-count"
          >
            {count !== null ? count.toLocaleString() : '—'}
          </span>
        </span>
        <span>
          dims{' '}
          <span
            style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            data-testid="knowledge-collection-dims"
          >
            {dims !== null ? dims : '—'}
          </span>
        </span>
        <span>
          embedder{' '}
          {embedder ? (
            <span
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
              data-testid="knowledge-collection-embedder"
            >
              {embedder.node}/{embedder.model}
            </span>
          ) : (
            <span
              style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-text-secondary)' }}
              data-testid="knowledge-collection-embedder"
            >
              none
            </span>
          )}
        </span>
      </div>
      {metaEntries.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {metaEntries.map(([k, v]) => (
            <span
              key={k}
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}
            >
              {k}: {typeof v === 'string' ? v : JSON.stringify(v)}
            </span>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <ul
          style={{ marginTop: 2, color: 'var(--color-warn,var(--color-ok))', fontSize: 12 }}
          data-testid="knowledge-collection-warnings"
        >
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function QueryTab(props: {
  nodeName: string;
  collection: string;
  onCollectionChange: (value: string) => void;
  embedder: EmbedderBinding | null;
  provider: RagProviderKind | null;
}): React.JSX.Element {
  const { nodeName, collection, onCollectionChange, embedder, provider } = props;
  const utils = trpc.useUtils();
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(10);
  const [filterText, setFilterText] = useState('');
  const [filterError, setFilterError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [lastResponse, setLastResponse] = useState<SearchResponse | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function onSubmit(): Promise<void> {
    setSubmitError(null);
    setFilterError(null);
    const q = query.trim();
    if (!q) {
      setSubmitError('Query text is required.');
      return;
    }

    let parsedFilter: Record<string, unknown> | undefined;
    if (filterText.trim()) {
      try {
        const value: unknown = JSON.parse(filterText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          setFilterError('Filter must be a JSON object.');
          return;
        }
        parsedFilter = value as Record<string, unknown>;
      } catch (err) {
        setFilterError(`Invalid JSON: ${(err as Error).message}`);
        return;
      }
    }

    const input: {
      node: string;
      query: string;
      topK: number;
      collection?: string;
      filter?: Record<string, unknown>;
    } = { node: nodeName, query: q, topK };
    if (collection.trim()) input.collection = collection.trim();
    if (parsedFilter) input.filter = parsedFilter;

    setIsSearching(true);
    try {
      const response = await utils.ragSearch.fetch(input);
      setLastResponse(response as SearchResponse);
    } catch (err) {
      setLastResponse(null);
      setSubmitError((err as Error).message);
    } finally {
      setIsSearching(false);
    }
  }

  const results = lastResponse?.results ?? [];

  return (
    <div style={{ marginTop: 16 }}>
      <CollectionHeader
        nodeName={nodeName}
        collection={collection}
        embedder={embedder}
        provider={provider}
      />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void onSubmit();
        }}
        style={{ marginTop: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16 }}
        data-testid="knowledge-query-form"
      >
        <label style={{ display: 'block', fontSize: 14 }}>
          <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Query
          </span>
          <textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask the knowledge base…"
            rows={3}
            style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
          />
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 4 / span 4', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              topK ({topK})
            </span>
            <Input
              type="range"
              min={1}
              max={100}
              value={topK}
              onChange={(e) => setTopK(Math.max(1, Number(e.target.value) || 10))}
              style={{ width: '100%' }}
            />
          </label>
          <label style={{ gridColumn: 'span 4 / span 4', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              Collection (optional)
            </span>
            <Input
              type="text"
              value={collection}
              onChange={(e) => onCollectionChange(e.target.value)}
              placeholder="defaults to node's collection"
              style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            />
          </label>
          <div style={{ gridColumn: 'span 4 / span 4', display: 'flex', alignItems: 'flex-end' }}>
            <Button variant="primary" size="sm"
              type="submit"
              disabled={isSearching}
              data-testid="knowledge-query-submit"
              
            >
              {isSearching ? 'Searching…' : 'Search'}
            </Button>
          </div>
        </div>
        <label style={{ display: 'block', fontSize: 14 }}>
          <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Filter (metadata JSON, optional)
          </span>
          <Input
            type="text"
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value);
              setFilterError(null);
            }}
            placeholder='e.g. {"source":"docs","lang":"en"}'
            style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
          />
          {filterError && (
            <span style={{ marginTop: 4, display: 'block', color: 'var(--color-err)', fontSize: 12 }}>
              {filterError}
            </span>
          )}
        </label>
      </form>

      {submitError && (
        <div
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}
          data-testid="knowledge-query-error"
        >
          Failed to reach <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{nodeName}</Badge>: {submitError}
        </div>
      )}

      {lastResponse && !submitError && (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12, color: 'var(--color-text-secondary)', fontSize: 12 }}>
          <span>
            {results.length} result{results.length === 1 ? '' : 's'}
          </span>
          <span> · collection </span>
          <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{lastResponse.collection}
          </Badge>
        </div>
      )}

      <div style={{ marginTop: 8 }} data-testid="knowledge-query-results">
        {results.length === 0 && lastResponse && (
          <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
            No results. Try lowering the similarity threshold or widening the query.
          </div>
        )}
        {results.map((r, i) => {
          const key = `${r.document.id}-${i}`;
          const isOpen = openResult === key;
          const hasMeta =
            !!r.document.metadata &&
            Object.keys(r.document.metadata).length > 0;
          return (
            <div
              key={key}
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span
                    style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2, fontSize: 10, background: r.score > 0.8 ? "var(--color-ok)" : "var(--color-surface-2)", color: "var(--color-text-inverse)" }}
                    title={`score ${r.score.toFixed(6)}${typeof r.distance === 'number' ? ` · distance ${r.distance.toFixed(6)}` : ''}`}
                  >
                    {formatScore(r.score)}
                  </span>
                  <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{r.document.id}
                  </Badge>
                  {typeof r.distance === 'number' && (
                    <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                      distance {r.distance.toFixed(4)}
                    </span>
                  )}
                </div>
                {hasMeta && (
                  <Button
                    type="button"
                    onClick={() => setOpenResult(isOpen ? null : key)}
                    style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text-secondary)' }}
                  >
                    {isOpen ? 'Hide metadata' : 'Show metadata'}
                  </Button>
                )}
              </div>
              <div style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--color-text)', fontSize: 14 }}>
                {truncateContent(r.document.content)}
              </div>
              {isOpen && hasMeta && (
                <pre style={{ marginTop: 8, overflowX: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}>
                  {JSON.stringify(r.document.metadata, null, 2)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Collections tab. Lists collections on the selected node. Clicking a
 * row stages the collection for the Query tab and switches to it.
 */
function CollectionsTab(props: {
  nodeName: string;
  onPick: (collection: string) => void;
}): React.JSX.Element {
  const { nodeName, onPick } = props;
  const list = trpc.ragListCollections.useQuery(
    { node: nodeName },
    { enabled: !!nodeName, retry: false },
  );

  if (list.isLoading) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        Loading collections…
      </div>
    );
  }
  if (list.error) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}>
        Failed to reach <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{nodeName}</Badge>:{' '}
        {list.error.message}
      </div>
    );
  }
  const data = list.data as ListCollectionsResponse | undefined;
  const rows = data?.collections ?? [];

  if (rows.length === 0) {
    return (
      <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
        No collections yet on <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{nodeName}</Badge>. Index a
        document in the Indexing tab to create one.
      </div>
    );
  }

  return (
    <div
      style={{ overflow: 'hidden', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
      data-testid="knowledge-collections-table"
    >
      <table style={{ width: '100%', fontFamily: 'var(--font-mono)', fontSize: 14 }}>
        <thead style={{ background: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
          <tr>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Name</th>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Count</th>
            <th style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500 }}>Dimensions</th>
            <th style={{ width: 112, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontWeight: 500, textAlign: 'right' }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr
              key={c.name}
              style={{ borderTop: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)' }}
            >
              <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-ok)', wordBreak: 'break-all' }}>
                {c.name}
              </td>
              <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text)' }}>
                {typeof c.count === 'number' ? c.count : '—'}
              </td>
              <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-text)' }}>
                {typeof c.dimensions === 'number' ? c.dimensions : '—'}
              </td>
              <td style={{ paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, textAlign: 'right' }}>
                <Button
                  type="button"
                  onClick={() => onPick(c.name)}
                  style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text-secondary)' }}
                >
                  Use in Query
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Indexing tab. Accepts either a JSON array of `{id, content, metadata?}`
 * or plain text paragraphs (auto-IDed). The mutation only fires when
 * the operator hits Submit — no autosave, no focus-blur side effects.
 */
function IndexingTab(props: { nodeName: string }): React.JSX.Element {
  const { nodeName } = props;
  const [text, setText] = useState('');
  const [collection, setCollection] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<StoreResponse | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const store = trpc.ragStore.useMutation({
    onSuccess: (data) => {
      setLastResult(data as StoreResponse);
      setSubmitError(null);
      setText('');
    },
    onError: (err) => {
      setLastResult(null);
      setSubmitError(err.message);
    },
  });

  function onSubmit(): void {
    setParseError(null);
    setSubmitError(null);
    const { documents, error } = parseIndexInput(text);
    if (error) {
      setParseError(error);
      return;
    }
    const input: {
      node: string;
      documents: IndexDocumentInput[];
      collection?: string;
    } = {
      node: nodeName,
      documents,
    };
    if (collection.trim()) input.collection = collection.trim();
    store.mutate(input);
  }

  const previewCount = (() => {
    const { documents, error } = parseIndexInput(text);
    if (error) return null;
    return documents.length;
  })();

  return (
    <div style={{ marginTop: 16 }}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        style={{ marginTop: 12, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16 }}
        data-testid="knowledge-indexing-form"
      >
        <label style={{ display: 'block', fontSize: 14 }}>
          <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Documents to index (JSON array or plain text paragraphs)
          </span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setParseError(null);
            }}
            rows={10}
            placeholder={`Paragraph-per-document:\n\nFirst paragraph becomes one doc.\n\nBlank lines separate documents.\n\nOr JSON:\n[{"id":"note-1","content":"…","metadata":{"source":"runbook"}}]`}
            style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)', fontSize: 12 }}
          />
          <span style={{ marginTop: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
            {previewCount != null
              ? `${previewCount} document${previewCount === 1 ? '' : 's'} will be stored.`
              : 'Starts with [ to parse as JSON; otherwise split on blank lines.'}
          </span>
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 8 / span 8', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              Collection (optional)
            </span>
            <Input
              type="text"
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder="defaults to node's collection"
              style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            />
          </label>
          <div style={{ gridColumn: 'span 4 / span 4', display: 'flex', alignItems: 'flex-end' }}>
            <Button variant="primary" size="sm"
              type="submit"
              disabled={store.isPending}
              data-testid="knowledge-indexing-submit"
              
            >
              {store.isPending ? 'Storing…' : 'Store documents'}
            </Button>
          </div>
        </div>
        {parseError && (
          <div style={{ color: 'var(--color-err)', fontSize: 12 }}>
            {parseError}
          </div>
        )}
      </form>

      {submitError && (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-err)', background: 'var(--color-surface-1)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, color: 'var(--color-err)', fontSize: 14 }}>
          Failed to reach <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{nodeName}</Badge>: {submitError}
        </div>
      )}

      {lastResult && (
        <div
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-ok)', background: 'var(--color-surface-1)', padding: 12 }}
          data-testid="knowledge-indexing-result"
        >
          <div style={{ color: 'var(--color-text)', fontSize: 14 }}>
            Stored {lastResult.ids.length} document
            {lastResult.ids.length === 1 ? '' : 's'} in{' '}
            <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{lastResult.collection}</Badge>.
          </div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text-secondary)' }}>
            {lastResult.ids.map((id) => (
              <span
                key={id}
                style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 6, paddingRight: 6, paddingTop: 2, paddingBottom: 2 }}
              >
                {id}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Embedder binding panel. Shows the current binding under the
 * selected RAG node and lets the operator swap or clear it. Chroma
 * embeds internally and ignores the binding — we still render the
 * panel for visibility, but explain the no-op inline.
 *
 * Optimistic update: flip the local state immediately, call
 * `nodeUpdateRagBinding`, then revert on error. Persistence is a
 * `nodeList` invalidation on success so the activity bar / other
 * consumers observe the change.
 */
function EmbedderPanel(props: {
  node: RagNodeSummary;
  agentNodes: AgentNodeSummary[];
}): React.JSX.Element {
  const { node, agentNodes } = props;
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draftNode, setDraftNode] = useState(node.embedder?.node ?? '');
  const [draftModel, setDraftModel] = useState(node.embedder?.model ?? '');
  const [optimistic, setOptimistic] = useState<EmbedderBinding | null | undefined>(
    undefined,
  );
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    // Reset drafts when the selected node changes. The fresh selection
    // is the source of truth; keep the form hydrated from it.
    setDraftNode(node.embedder?.node ?? '');
    setDraftModel(node.embedder?.model ?? '');
    setOptimistic(undefined);
    setEditing(false);
    setError(null);
  }, [node.name, node.embedder?.node, node.embedder?.model]);

  const mutation = trpc.nodeUpdateRagBinding.useMutation({
    onSuccess: async () => {
      setError(null);
      setEditing(false);
      await utils.nodeList.invalidate();
      setOptimistic(undefined);
    },
    onError: (err) => {
      setError(err.message);
      setOptimistic(undefined);
    },
  });

  const shown = optimistic !== undefined ? optimistic : node.embedder;

  function onSave(): void {
    const n = draftNode.trim();
    const m = draftModel.trim();
    if (!n || !m) {
      setError('Embedder node and model are both required.');
      return;
    }
    setError(null);
    const next: EmbedderBinding = { node: n, model: m };
    setOptimistic(next);
    mutation.mutate({ node: node.name, embedder: next });
  }

  function onClear(): void {
    setError(null);
    setOptimistic(null);
    mutation.mutate({ node: node.name, embedder: null });
  }

  return (
    <div
      style={{ marginBottom: 16, borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 12 }}
      data-testid="knowledge-embedder-panel"
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
          <div style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Embedder</div>
          {shown ? (
            <div
              style={{ color: 'var(--color-text)' }}
              data-testid="knowledge-embedder-current"
            >
              node{' '}
              <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{shown.node}
              </Badge>
              <span> · model </span>
              <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{shown.model}
              </Badge>
            </div>
          ) : (
            <div
              style={{ color: 'var(--color-text-secondary)' }}
              data-testid="knowledge-embedder-current"
            >
              none
            </div>
          )}
          {node.provider === 'chroma' && (
            <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-secondary)' }}>
              Chroma embeds internally — this binding is ignored by chroma
              nodes, but persists for operator visibility.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {!editing ? (
            <Button
              type="button"
              onClick={() => {
                setDraftNode(shown?.node ?? '');
                setDraftModel(shown?.model ?? '');
                setEditing(true);
              }}
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-edit"
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text-secondary)', cursor: 'not-allowed', opacity: 0.5 }}
            >
              Edit embedder
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              disabled={mutation.isPending}
              style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 2, paddingBottom: 2, fontSize: 10, color: 'var(--color-text-secondary)', cursor: 'not-allowed', opacity: 0.5 }}
            >
              Cancel
            </Button>
          )}
          {shown && !editing && (
            <Button variant="secondary" size="sm"
              type="button"
              onClick={onClear}
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-clear"
              
            >
              Clear embedder
            </Button>
          )}
        </div>
      </div>

      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave();
          }}
          style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}
          data-testid="knowledge-embedder-form"
        >
          <label style={{ gridColumn: 'span 5 / span 5', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              Node
            </span>
            <select
              value={draftNode}
              onChange={(e) => setDraftNode(e.target.value)}
              data-testid="knowledge-embedder-node-select"
              style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            >
              <option value="">(pick a node)</option>
              {draftNode &&
                !agentNodes.some((n) => n.name === draftNode) && (
                  <option value={draftNode}>{draftNode} (current)</option>
                )}
              {agentNodes.map((n) => (
                <option key={n.name} value={n.name}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ gridColumn: 'span 5 / span 5', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
              Model
            </span>
            <Input
              type="text"
              value={draftModel}
              onChange={(e) => setDraftModel(e.target.value)}
              placeholder="e.g. nomic-embed-text-v1.5"
              data-testid="knowledge-embedder-model-input"
              style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
            />
          </label>
          <div style={{ gridColumn: 'span 2 / span 2', display: 'flex', alignItems: 'flex-end' }}>
            <Button variant="primary" size="sm"
              type="submit"
              disabled={mutation.isPending}
              data-testid="knowledge-embedder-save"
              
            >
              {mutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </form>
      )}

      {error && (
        <div
          style={{ marginTop: 8, color: 'var(--color-err)', fontSize: 12 }}
          data-testid="knowledge-embedder-error"
        >
          {error}
        </div>
      )}
    </div>
  );
}

export default function Knowledge(): React.JSX.Element {
  const nodes = trpc.nodeList.useQuery();
  const ragNodes = useMemo<RagNodeSummary[]>(() => {
    const rows = nodes.data?.nodes ?? [];
    return rows
      .filter((n) => {
        const eff = (n as { effectiveKind?: string }).effectiveKind;
        return eff === 'rag';
      })
      .map((n) => {
        const embedder = n.rag?.embedder;
        return {
          name: n.name,
          provider:
            (n.rag?.provider as RagProviderKind | undefined) ?? null,
          kind: 'rag' as const,
          embedder:
            embedder && typeof embedder === 'object'
              ? {
                  node: String((embedder as EmbedderBinding).node),
                  model: String((embedder as EmbedderBinding).model),
                }
              : null,
        };
      });
  }, [nodes.data]);
  const agentNodes = useMemo<AgentNodeSummary[]>(() => {
    const rows = nodes.data?.nodes ?? [];
    return rows
      .filter((n) => {
        const eff = (n as { effectiveKind?: string }).effectiveKind;
        return eff === 'agent';
      })
      .map((n) => ({ name: n.name, endpoint: n.endpoint }));
  }, [nodes.data]);

  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('query');
  const [queryCollection, setQueryCollection] = useState('');

  // Auto-select the first RAG node once the list loads.
  React.useEffect(() => {
    const first = ragNodes[0];
    if (!selectedNode && first) {
      setSelectedNode(first.name);
      return;
    }
    if (selectedNode && !ragNodes.some((n) => n.name === selectedNode)) {
      setSelectedNode(first?.name ?? null);
    }
  }, [ragNodes, selectedNode]);

  const selected = ragNodes.find((n) => n.name === selectedNode) ?? null;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="knowledge-retrieval-root">
      <div style={{ marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Knowledge
      </div>
      <h1 style={{ marginBottom: 8, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Retrieval-Augmented Generation
      </h1>
      <p style={{ marginBottom: 24, color: 'var(--color-text-secondary)', fontSize: 12 }}>
        Query, browse, and index documents against the RAG nodes registered in
        your kubeconfig. Supported providers:{' '}
        <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>chroma</Badge> and{' '}
        <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>pgvector</Badge>.
      </p>

      {nodes.isLoading && (
        <div style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 16, color: 'var(--color-text-secondary)', fontSize: 14 }}>
          Loading nodes…
        </div>
      )}

      {!nodes.isLoading && ragNodes.length === 0 && (
        <div
          style={{ borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderStyle: 'dashed', borderColor: 'var(--color-border)', background: 'var(--color-surface-1)', padding: 24 }}
          data-testid="knowledge-empty-state"
        >
          <div style={{ color: 'var(--color-text)', fontSize: 14 }}>
            No knowledge bases yet — register one with{' '}
            <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>llamactl node add …</Badge>.
          </div>
          <p style={{ marginTop: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Example for a Chroma node backed by the chroma-mcp server:
          </p>
          <pre style={{ marginTop: 4, overflowX: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}>{`llamactl node add kb-chroma \\
  --rag=chroma \\
  --endpoint="chroma-mcp run --persist-directory /path/to/chroma-data"`}</pre>
          <p style={{ marginTop: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
            Or a pgvector node against a running Postgres with the{' '}
            <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>vector</Badge> extension:
          </p>
          <pre style={{ marginTop: 4, overflowX: 'auto', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', padding: 8, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--color-text)' }}>{`llamactl node add kb-pg \\
  --rag=pgvector \\
  --endpoint="postgres://kb_user:$PG_PASSWORD@db.local:5432/kb_main"`}</pre>
        </div>
      )}

      {ragNodes.length > 0 && selected && (
        <>
          <div style={{ marginBottom: 16, display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
            <label style={{ gridColumn: 'span 6 / span 6', fontSize: 14 }}>
              <span style={{ marginBottom: 4, display: 'block', color: 'var(--color-text-secondary)', fontSize: 12 }}>
                RAG node
              </span>
              <select
                value={selected.name}
                onChange={(e) => setSelectedNode(e.target.value)}
                data-testid="knowledge-node-select"
                style={{ width: '100%', borderRadius: 'var(--r-md)', border: '1px solid var(--color-border)', borderColor: 'var(--color-border)', background: 'var(--color-surface-2)', paddingLeft: 8, paddingRight: 8, paddingTop: 4, paddingBottom: 4, fontFamily: 'var(--font-mono)', color: 'var(--color-text)' }}
              >
                {ragNodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                    {n.provider ? ` — ${n.provider}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ gridColumn: 'span 6 / span 6', display: 'flex', alignItems: 'flex-end', gap: 8, color: 'var(--color-text-secondary)', fontSize: 12 }}>
              <span>
                kind <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>rag</Badge>
              </span>
              {selected.provider && (
                <span>
                  · provider{' '}
                  <Badge variant="default" style={{ fontFamily: 'var(--font-mono)' }}>{selected.provider}
                  </Badge>
                </span>
              )}
            </div>
          </div>

          <EmbedderPanel node={selected} agentNodes={agentNodes} />

          <div
            style={{ marginBottom: 16, display: 'flex', gap: 4, borderBottom: '1px solid var(--color-border)', borderColor: 'var(--color-border)' }}
            data-testid="knowledge-tabs"
          >
            {(
              [
                { id: 'query', label: 'Query' },
                { id: 'collections', label: 'Collections' },
                { id: 'indexing', label: 'Indexing' },
                { id: 'pipelines', label: 'Pipelines' },
                { id: 'quality', label: 'Quality' },
              ] as { id: TabId; label: string }[]
            ).map((tab) => {
              const active = tab.id === activeTab;
              return (
                <Button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`knowledge-tab-${tab.id}`}
                  style={{ ...( active ? { borderBottom: '2px solid var(--color-border)', borderColor: 'var(--color-brand)', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 14, fontWeight: 500, color: 'var(--color-text)' } : { borderBottom: '2px solid var(--color-border)', borderColor: 'transparent', paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, fontSize: 14, color: 'var(--color-text-secondary)' } ) }}
                >
                  {tab.label}
                </Button>
              );
            })}
          </div>

          <div data-testid={`knowledge-panel-${activeTab}`}>
            {activeTab === 'query' && (
              <QueryTab
                nodeName={selected.name}
                collection={queryCollection}
                onCollectionChange={setQueryCollection}
                embedder={selected.embedder}
                provider={selected.provider}
              />
            )}
            {activeTab === 'collections' && (
              <CollectionsTab
                nodeName={selected.name}
                onPick={(collection) => {
                  setQueryCollection(collection);
                  setActiveTab('query');
                }}
              />
            )}
            {activeTab === 'indexing' && <IndexingTab nodeName={selected.name} />}
            {activeTab === 'quality' && (
              <QualityTab nodeName={selected.name} collection={queryCollection} />
            )}
            {activeTab === 'pipelines' && (
              <PipelinesTab
                nodeName={selected.name}
                availableNodes={ragNodes.map((n) => n.name)}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
