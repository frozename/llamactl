import * as React from "react";
import { useState } from "react";
import { stringify as stringifyYaml } from "yaml";

import { trpc, trpcUIClient } from "@/lib/trpc";
import { Badge, Button } from "@/ui";
import type { BadgeVariant } from "@/ui";

import type { DetectedRepo, ProjectManifest, RoutePreviewResponse, RoutingDecision } from "./types";

import { useGitRepoScanner, useRoutingJournal } from "./hooks";

const dashedBoxStyle: React.CSSProperties = {
  borderRadius: "var(--r-md)",
  border: "1px solid var(--color-border)",
  borderStyle: "dashed",
  borderColor: "var(--color-border)",
  background: "var(--color-surface-1)",
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 8,
  paddingBottom: 8,
  fontSize: 12,
  color: "var(--color-text-secondary)",
};

const cellPadStyle: React.CSSProperties = {
  paddingLeft: 8,
  paddingRight: 8,
  paddingTop: 4,
  paddingBottom: 4,
};

const headCellStyle: React.CSSProperties = { ...cellPadStyle, fontWeight: 500 };

const rowBorderStyle: React.CSSProperties = {
  borderTop: "1px solid var(--color-border)",
  borderColor: "var(--color-border)",
};

const rowCellPadStyle: React.CSSProperties = {
  paddingLeft: 12,
  paddingRight: 12,
  paddingTop: 8,
  paddingBottom: 8,
};

const sectionLabelStyle: React.CSSProperties = {
  marginBottom: 8,
  fontSize: 12,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "var(--color-text-secondary)",
};

const textInputStyle: React.CSSProperties = {
  width: "100%",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--color-border)",
  borderColor: "var(--color-border)",
  background: "var(--color-surface-2)",
  paddingLeft: 8,
  paddingRight: 8,
  paddingTop: 4,
  paddingBottom: 4,
  fontSize: 12,
  color: "var(--color-text)",
};

const monoInputStyle: React.CSSProperties = {
  ...textInputStyle,
  fontFamily: "var(--font-mono)",
};

function reasonBadgeVariant(reason: RoutingDecision["reason"]): BadgeVariant {
  if (reason === "matched") return "ok";
  if (reason === "fallback-default") return "default";
  return "err";
}

function formatElapsed(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  const d = Math.floor(h / 24);
  return `${String(d)}d ago`;
}

export function RoutingHeatmap(props: {
  routing: Record<string, string> | undefined;
}): React.JSX.Element {
  const entries = Object.entries(props.routing ?? {});
  if (entries.length === 0) {
    return <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>no policy</span>;
  }
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {entries.map(([k, v]) => (
        <Badge key={k} variant="default" title={`${k} → ${v}`}>
          {k} → {v}
        </Badge>
      ))}
    </div>
  );
}

export function RoutingPreviewCard(props: {
  project: string;
  taskKind: string;
}): React.JSX.Element {
  const { project, taskKind } = props;
  const q = trpc.projectRoutePreview.useQuery(
    { node: `project:${project}/${taskKind}` },
    { retry: false },
  );
  const data = q.data as RoutePreviewResponse | undefined;
  if (q.isLoading) {
    return <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>…</span>;
  }
  if (q.error || !data?.decision) {
    return <span style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>—</span>;
  }
  const d = data.decision;
  return (
    <Badge
      variant={reasonBadgeVariant(d.reason)}
      title={`reason: ${d.reason}${d.budget ? ` · budget ${d.budget.usdToday?.toFixed(4) ?? "?"}/${d.budget.limit?.toFixed(2) ?? "?"} USD` : ""}`}
      data-testid={`projects-preview-${project}-${taskKind}`}
    >
      {d.target}
    </Badge>
  );
}

export function RoutingJournalFeed(props: { project: string }): React.JSX.Element {
  const { project } = props;
  const { q, entries } = useRoutingJournal(project);

  if (q.isLoading) {
    return <div style={dashedBoxStyle}>Loading decisions…</div>;
  }
  if (entries.length === 0) {
    return (
      <div style={dashedBoxStyle} data-testid="projects-journal-empty">
        No routing decisions journaled yet — trigger a chat against{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>project:{project}/&lt;taskKind&gt;</span>{" "}
        to populate this feed.
      </div>
    );
  }
  return <JournalTable entries={entries} />;
}

function JournalTable({ entries }: { entries: RoutingDecision[] }): React.JSX.Element {
  const reversed = [...entries].reverse();
  const monoCellStyle: React.CSSProperties = {
    ...cellPadStyle,
    fontFamily: "var(--font-mono)",
    fontSize: 10,
  };
  return (
    <div
      style={{
        overflow: "auto",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
      }}
      data-testid="projects-journal"
    >
      <table style={{ width: "100%", fontSize: 12 }}>
        <thead
          style={{
            background: "var(--color-surface-2)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={headCellStyle}>Elapsed</th>
            <th style={{ ...headCellStyle, width: 128 }}>Task kind</th>
            <th style={headCellStyle}>Target</th>
            <th style={{ ...headCellStyle, width: 128 }}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {reversed.map((d, i) => (
            <tr key={`${d.ts}-${String(i)}`} style={rowBorderStyle}>
              <td style={{ ...monoCellStyle, color: "var(--color-text-secondary)" }}>
                {formatElapsed(d.ts)}
              </td>
              <td style={{ ...monoCellStyle, color: "var(--color-text)" }}>{d.taskKind}</td>
              <td style={{ ...monoCellStyle, color: "var(--color-text)", wordBreak: "break-all" }}>
                {d.target}
              </td>
              <td style={cellPadStyle}>
                <Badge variant={reasonBadgeVariant(d.reason)}>{d.reason}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectDetail(props: {
  project: ProjectManifest;
  onClose: () => void;
  onRemoved: () => void;
}): React.JSX.Element {
  const { project, onClose, onRemoved } = props;
  const utils = trpc.useUtils();
  const taskKinds = Object.keys(project.spec.routing ?? {});
  const removeMut = trpc.projectRemove.useMutation({
    onSuccess: async () => {
      await utils.projectList.invalidate();
      onRemoved();
    },
  });
  const onRemove = (): void => {
    // eslint-disable-next-line no-alert -- Preserve the existing synchronous destructive confirmation flow.
    if (!confirm(`Remove project '${project.metadata.name}'? Indexed data stays in the rag node.`))
      return;
    removeMut.mutate({ name: project.metadata.name });
  };

  return (
    <div
      style={{
        marginTop: 16,
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-0)",
        padding: 16,
      }}
      data-testid={`projects-detail-${project.metadata.name}`}
    >
      <ProjectDetailHeader
        project={project}
        onRemove={onRemove}
        onClose={onClose}
        removePending={removeMut.isPending}
      />
      {taskKinds.length > 0 && <RoutingPolicyPreview project={project} taskKinds={taskKinds} />}
      <div>
        <div style={sectionLabelStyle}>Routing decisions (live)</div>
        <RoutingJournalFeed project={project.metadata.name} />
      </div>
      <ProjectManifestViewer project={project} />
    </div>
  );
}

function ProjectDetailHeader({
  project,
  onRemove,
  onClose,
  removePending,
}: {
  project: ProjectManifest;
  onRemove: () => void;
  onClose: () => void;
  removePending: boolean;
}): React.JSX.Element {
  return (
    <div
      style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}
    >
      <div>
        <div
          style={{
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--color-text-secondary)",
          }}
        >
          Project
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 18, color: "var(--color-text)" }}>
          {project.metadata.name}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "var(--color-text-secondary)",
          }}
        >
          {project.spec.path}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => {
            onRemove();
          }}
          disabled={removePending}
          data-testid={`projects-remove-${project.metadata.name}`}
        >
          Remove
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
          }}
          data-testid="projects-detail-close"
        >
          Close
        </Button>
      </div>
    </div>
  );
}

function RoutingPolicyPreview({
  project,
  taskKinds,
}: {
  project: ProjectManifest;
  taskKinds: string[];
}): React.JSX.Element {
  return (
    <div>
      <div style={sectionLabelStyle}>Routing policy preview</div>
      <div
        style={{
          overflow: "hidden",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
        }}
        data-testid="projects-policy-table"
      >
        <table style={{ width: "100%", fontSize: 12 }}>
          <thead
            style={{
              background: "var(--color-surface-1)",
              textAlign: "left",
              color: "var(--color-text-secondary)",
            }}
          >
            <tr>
              <th style={headCellStyle}>Task kind</th>
              <th style={headCellStyle}>Declared target</th>
              <th style={headCellStyle}>Resolved (live)</th>
            </tr>
          </thead>
          <tbody>
            {taskKinds.map((k) => (
              <tr key={k} style={{ ...rowBorderStyle, background: "var(--color-surface-1)" }}>
                <td
                  style={{
                    ...cellPadStyle,
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text)",
                  }}
                >
                  {k}
                </td>
                <td
                  style={{
                    ...cellPadStyle,
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "var(--color-text-secondary)",
                  }}
                >
                  {project.spec.routing?.[k]}
                </td>
                <td style={cellPadStyle}>
                  <RoutingPreviewCard project={project.metadata.name} taskKind={k} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProjectManifestViewer({ project }: { project: ProjectManifest }): React.JSX.Element {
  return (
    <div>
      <div style={sectionLabelStyle}>Manifest</div>
      <pre
        style={{
          overflow: "auto",
          borderRadius: "var(--r-md)",
          border: "1px solid var(--color-border)",
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
          padding: 12,
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          color: "var(--color-text)",
        }}
        data-testid={`projects-manifest-${project.metadata.name}`}
      >
        {stringifyYaml(project)}
      </pre>
    </div>
  );
}

export function ProjectRow(props: {
  project: ProjectManifest;
  onOpenDetail: () => void;
}): React.JSX.Element {
  const { project, onOpenDetail } = props;
  const utils = trpc.useUtils();
  const [indexError, setIndexError] = useState<string | null>(null);
  const indexMut = trpc.projectIndex.useMutation({
    onSuccess: async () => {
      setIndexError(null);
      await utils.projectList.invalidate();
    },
    onError: (err) => {
      setIndexError(err.message);
    },
  });
  const hasRag = !!project.spec.rag;
  return (
    <tr
      style={{ ...rowBorderStyle, background: "var(--color-surface-1)" }}
      data-testid={`projects-row-${project.metadata.name}`}
    >
      <td style={{ ...rowCellPadStyle, color: "var(--color-ok)", wordBreak: "break-all" }}>
        <button
          type="button"
          onClick={() => {
            onOpenDetail();
          }}
          style={{ textAlign: "left" }}
          data-testid={`projects-open-${project.metadata.name}`}
        >
          {project.metadata.name}
        </button>
      </td>
      <td
        style={{
          ...rowCellPadStyle,
          color: "var(--color-text-secondary)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          wordBreak: "break-all",
        }}
      >
        {project.spec.path}
      </td>
      <td style={{ ...rowCellPadStyle, fontSize: 10 }}>
        {project.spec.rag ? (
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--color-text)" }}>
            {project.spec.rag.node}/{project.spec.rag.collection}
          </span>
        ) : (
          <span style={{ color: "var(--color-text-secondary)" }}>no rag block</span>
        )}
      </td>
      <td style={rowCellPadStyle}>
        <RoutingHeatmap routing={project.spec.routing} />
      </td>
      <td style={{ ...rowCellPadStyle, textAlign: "right" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              indexMut.mutate({ name: project.metadata.name });
            }}
            disabled={indexMut.isPending || !hasRag}
            loading={indexMut.isPending}
            data-testid={`projects-index-${project.metadata.name}`}
            title={
              hasRag
                ? "Apply + run the auto-generated RAG pipeline"
                : "No rag block declared; add one in the manifest to enable indexing"
            }
          >
            {indexMut.isPending ? "…" : "Index"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onOpenDetail();
            }}
            data-testid={`projects-detail-button-${project.metadata.name}`}
          >
            Detail
          </Button>
        </div>
        {indexError && (
          <div style={{ marginTop: 4, fontSize: 10, color: "var(--color-err)" }}>{indexError}</div>
        )}
      </td>
    </tr>
  );
}

export function GitRepoSuggestions({
  onPick,
}: {
  onPick: (r: DetectedRepo) => void;
}): React.JSX.Element | null {
  const { state, expanded, setExpanded } = useGitRepoScanner();

  if (state.kind === "loading")
    return (
      <div style={{ fontSize: 10, color: "var(--color-text-secondary)" }}>
        Scanning for git repos…
      </div>
    );
  if (state.kind === "error" || state.repos.length === 0) return null;

  const visible = expanded ? state.repos : state.repos.slice(0, 8);
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        <span>Detected git repos</span>
        <span style={{ opacity: 0.6 }}>
          ({state.repos.length} across {state.rootsShown.length} root
          {state.rootsShown.length === 1 ? "" : "s"})
        </span>
      </div>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
        data-testid="projects-git-suggestions"
      >
        {visible.map((repo) => (
          <Button
            key={repo.path}
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              onPick(repo);
            }}
            title={repo.path}
          >
            {repo.name}
          </Button>
        ))}
        {!expanded && state.repos.length > visible.length && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setExpanded(true);
            }}
          >
            +{state.repos.length - visible.length} more
          </Button>
        )}
      </div>
    </div>
  );
}

const compactFormStyle: React.CSSProperties = {
  borderRadius: "var(--r-md)",
  border: "1px solid var(--color-border)",
  borderColor: "var(--color-border)",
  background: "var(--color-surface-1)",
  padding: 12,
};

const compactFieldRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: 8,
};

const submitRowStyle: React.CSSProperties = {
  gridColumn: "span 2 / span 2",
  display: "flex",
  alignItems: "center",
  gap: 8,
};

function CreateProjectStatus({
  status,
}: {
  status: { kind: "idle" | "ok" | "error"; message?: string };
}): React.JSX.Element | null {
  if (status.kind === "idle") return null;
  return (
    <span
      style={{
        fontSize: 11,
        color: status.kind === "ok" ? "var(--color-ok)" : "var(--color-err)",
      }}
    >
      {status.kind === "ok" ? "✓ " : ""}
      {status.message}
    </span>
  );
}

export function CreateProjectForm({ compact }: { compact?: boolean } = {}): React.JSX.Element {
  const utils = trpc.useUtils();
  const nodesQuery = trpc.nodeList.useQuery();
  const [name, setName] = React.useState("");
  const [path, setPath] = React.useState("");
  const [purpose, setPurpose] = React.useState("");
  const [ragNode, setRagNode] = React.useState("");
  const [ragCollection, setRagCollection] = React.useState("");
  const [status, setStatus] = React.useState<{ kind: "idle" | "ok" | "error"; message?: string }>({
    kind: "idle",
  });

  const apply = trpc.projectApply.useMutation({
    onSuccess: async () => {
      await utils.projectList.invalidate();
      setName("");
      setPath("");
      setStatus({ kind: "ok", message: "project created" });
    },
    onError: (err) => {
      setStatus({ kind: "error", message: err.message });
    },
  });

  const onSubmit = (e: React.SyntheticEvent): void => {
    e.preventDefault();
    const manifest = {
      apiVersion: "llamactl/v1",
      kind: "Project",
      metadata: { name: name.trim() },
      spec: {
        path: path.trim(),
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(ragNode && ragCollection.trim()
          ? { rag: { node: ragNode, collection: ragCollection.trim() } }
          : {}),
      },
    };
    apply.mutate({ manifestYaml: stringifyYaml(manifest) });
  };

  const ragNodes = (nodesQuery.data?.nodes ?? []).filter((n) => n.effectiveKind === "rag");
  const canSubmit = name.trim().length > 0 && path.trim().length > 0;

  return (
    <form
      onSubmit={onSubmit}
      style={compact ? compactFormStyle : undefined}
      data-testid="projects-create-form"
    >
      {!compact && (
        <GitRepoSuggestions
          onPick={(repo) => {
            setPath(repo.path);
            if (!name.trim()) setName(repo.name);
          }}
        />
      )}
      <div style={compact ? compactFieldRowStyle : { display: "grid", gap: 12 }}>
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="novaflow"
            style={monoInputStyle}
            required
            data-testid="projects-create-name"
          />
        </Field>
        <ProjectPathField
          path={path}
          setPath={setPath}
          onPickedDir={(picked) => {
            setPath(picked);
            if (!name.trim()) setName(picked.split("/").filter(Boolean).pop() ?? "");
          }}
        />
        {!compact && (
          <CreateProjectExtendedFields
            purpose={purpose}
            setPurpose={setPurpose}
            ragNode={ragNode}
            setRagNode={setRagNode}
            ragCollection={ragCollection}
            setRagCollection={setRagCollection}
            ragNodes={ragNodes}
          />
        )}
        <div style={compact ? undefined : submitRowStyle}>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            disabled={!canSubmit || apply.isPending}
            loading={apply.isPending}
            data-testid="projects-create-submit"
          >
            {apply.isPending ? "Creating…" : compact ? "Add" : "Create project"}
          </Button>
          <CreateProjectStatus status={status} />
        </div>
      </div>
    </form>
  );
}

function ProjectPathField({
  path,
  setPath,
  onPickedDir,
}: {
  path: string;
  setPath: (v: string) => void;
  onPickedDir: (picked: string) => void;
}): React.JSX.Element {
  return (
    <Field label="Path" required>
      <div style={{ display: "flex", gap: 4 }}>
        <input
          type="text"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
          }}
          placeholder="/Users/you/repos/novaflow"
          style={{ ...monoInputStyle, width: undefined, flex: 1 }}
          required
          data-testid="projects-create-path"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() =>
            void (async (): Promise<void> => {
              const picked = await trpcUIClient.uiPickDirectory.mutate({
                title: "Pick a project directory",
                defaultPath: path || undefined,
              });
              if (picked) onPickedDir(picked);
            })()
          }
          data-testid="projects-create-pick-dir"
          title="Pick directory…"
        >
          Browse…
        </Button>
      </div>
    </Field>
  );
}

function CreateProjectExtendedFields({
  purpose,
  setPurpose,
  ragNode,
  setRagNode,
  ragCollection,
  setRagCollection,
  ragNodes,
}: {
  purpose: string;
  setPurpose: (v: string) => void;
  ragNode: string;
  setRagNode: (v: string) => void;
  ragCollection: string;
  setRagCollection: (v: string) => void;
  ragNodes: { name: string }[];
}): React.JSX.Element {
  return (
    <>
      <Field label="Purpose">
        <input
          type="text"
          value={purpose}
          onChange={(e) => {
            setPurpose(e.target.value);
          }}
          placeholder="e.g. at-home diagnostic services platform"
          style={textInputStyle}
        />
      </Field>
      <Field label="RAG node (optional)">
        <select
          value={ragNode}
          onChange={(e) => {
            setRagNode(e.target.value);
          }}
          style={textInputStyle}
        >
          <option value="">— skip RAG binding —</option>
          {ragNodes.map((n) => (
            <option key={n.name} value={n.name}>
              {n.name}
            </option>
          ))}
        </select>
      </Field>
      {ragNode && (
        <Field label="RAG collection">
          <input
            type="text"
            value={ragCollection}
            onChange={(e) => {
              setRagCollection(e.target.value);
            }}
            placeholder="novaflow_docs"
            style={monoInputStyle}
          />
        </Field>
      )}
    </>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        {label}
        {required && <span style={{ color: "var(--color-err)" }}>*</span>}
      </span>
      {children}
    </label>
  );
}
