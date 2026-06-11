import * as React from "react";
import { useState } from "react";
import { stringify as stringifyYaml } from "yaml";

import { trpc, trpcUIClient } from "@/lib/trpc";
import { Badge, Button } from "@/ui";
import type { BadgeVariant } from "@/ui";

import type { DetectedRepo, ProjectManifest, RoutePreviewResponse, RoutingDecision } from "./types";

import { useGitRepoScanner, useRoutingJournal } from "./hooks";

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
    return (
      <div className="p-2 text-xs border border-dashed rounded bg-surface-1 text-secondary">
        Loading decisions…
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <div
        className="p-2 text-xs border border-dashed rounded bg-surface-1 text-secondary"
        data-testid="projects-journal-empty"
      >
        No routing decisions journaled yet — trigger a chat against{" "}
        <span className="font-mono">project:{project}/&lt;taskKind&gt;</span> to populate this feed.
      </div>
    );
  }
  return <JournalTable entries={entries} />;
}

function JournalTable({ entries }: { entries: RoutingDecision[] }): React.JSX.Element {
  const reversed = [...entries].reverse();
  return (
    <div
      className="overflow-auto border rounded bg-surface-1 border-border"
      data-testid="projects-journal"
    >
      <table className="w-full text-xs">
        <thead className="text-left bg-surface-2 text-secondary">
          <tr>
            <th className="px-2 py-1 font-medium">Elapsed</th>
            <th className="w-32 px-2 py-1 font-medium">Task kind</th>
            <th className="px-2 py-1 font-medium">Target</th>
            <th className="w-32 px-2 py-1 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {reversed.map((d, i) => (
            <tr key={`${d.ts}-${String(i)}`} className="border-t border-border">
              <td className="px-2 py-1 font-mono text-[10px] text-secondary">
                {formatElapsed(d.ts)}
              </td>
              <td className="px-2 py-1 font-mono text-[10px] text-primary">{d.taskKind}</td>
              <td className="px-2 py-1 font-mono text-[10px] text-primary break-all">{d.target}</td>
              <td className="px-2 py-1">
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
      className="p-4 mt-4 border rounded bg-surface-0 border-border"
      data-testid={`projects-detail-${project.metadata.name}`}
    >
      <ProjectDetailHeader
        project={project}
        onRemove={onRemove}
        onClose={onClose}
        removePending={removeMut.isPending}
      />
      {taskKinds.length > 0 && <RoutingPolicyPreview project={project} taskKinds={taskKinds} />}
      <div className="mt-4">
        <div className="mb-2 text-xs font-medium tracking-wide uppercase text-secondary">
          Routing decisions (live)
        </div>
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
    <div className="flex items-baseline justify-between gap-3">
      <div>
        <div className="text-xs font-medium tracking-wide uppercase text-secondary">Project</div>
        <div className="font-mono text-lg text-primary">{project.metadata.name}</div>
        <div className="font-mono text-xs text-secondary">{project.spec.path}</div>
      </div>
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            onRemove();
          }}
          disabled={removePending}
        >
          Remove
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            onClose();
          }}
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
    <div className="mt-4">
      <div className="mb-2 text-xs font-medium tracking-tight uppercase text-secondary">
        Routing policy preview
      </div>
      <div
        className="overflow-hidden border rounded border-border"
        data-testid="projects-policy-table"
      >
        <table className="w-full text-xs">
          <thead className="text-left bg-surface-1 text-secondary">
            <tr>
              <th className="px-2 py-1 font-medium">Task kind</th>
              <th className="px-2 py-1 font-medium">Declared target</th>
              <th className="px-2 py-1 font-medium">Resolved (live)</th>
            </tr>
          </thead>
          <tbody>
            {taskKinds.map((k) => (
              <tr key={k} className="border-t border-border bg-surface-1">
                <td className="px-2 py-1 font-mono text-primary">{k}</td>
                <td className="px-2 py-1 font-mono text-[10px] text-secondary">
                  {project.spec.routing?.[k]}
                </td>
                <td className="px-2 py-1">
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
    <div className="mt-4">
      <div className="mb-2 text-xs font-medium tracking-tight uppercase text-secondary">
        Manifest
      </div>
      <pre
        className="p-3 overflow-auto font-mono text-[10px] border rounded bg-surface-2 border-border text-primary"
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
      className="border-t border-border bg-surface-1"
      data-testid={`projects-row-${project.metadata.name}`}
    >
      <td className="px-3 py-2 text-ok break-all">
        <button
          type="button"
          onClick={() => {
            onOpenDetail();
          }}
          className="text-left"
          data-testid={`projects-open-${project.metadata.name}`}
        >
          {project.metadata.name}
        </button>
      </td>
      <td className="px-3 py-2 font-mono text-[10px] text-secondary break-all">
        {project.spec.path}
      </td>
      <td className="px-3 py-2 text-[10px]">
        {project.spec.rag ? (
          <span className="font-mono text-primary">
            {project.spec.rag.node}/{project.spec.rag.collection}
          </span>
        ) : (
          <span className="text-secondary">no rag block</span>
        )}
      </td>
      <td className="px-3 py-2">
        <RoutingHeatmap routing={project.spec.routing} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              indexMut.mutate({ name: project.metadata.name });
            }}
            disabled={indexMut.isPending || !hasRag}
            loading={indexMut.isPending}
            data-testid={`projects-index-${project.metadata.name}`}
            title={hasRag ? "Apply + run RAG pipeline" : "No rag block declared"}
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
        {indexError && <div className="mt-1 text-[10px] text-err">{indexError}</div>}
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
    return <div className="text-[10px] text-secondary">Scanning for git repos\u2026</div>;
  if (state.kind === "error" || state.repos.length === 0) return null;

  const visible = expanded ? state.repos : state.repos.slice(0, 8);
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-2 text-[10px] font-medium uppercase tracking-wide text-secondary">
        <span>Detected git repos</span>
        <span className="opacity-60">
          ({state.repos.length} across {state.rootsShown.length} root
          {state.rootsShown.length === 1 ? "" : "s"})
        </span>
      </div>
      <div className="flex flex-wrap gap-1" data-testid="projects-git-suggestions">
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
      className={compact ? "p-3 border rounded bg-surface-1 border-border" : ""}
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
      <div className={compact ? "flex flex-wrap items-end gap-2" : "grid gap-3 mt-4"}>
        <Field label="Name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
            }}
            placeholder="novaflow"
            className="w-full px-2 py-1 font-mono text-xs border rounded bg-surface-2 border-border text-primary"
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
        <div className={compact ? "" : "col-span-2 flex items-center gap-2"}>
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
          {status.kind !== "idle" && (
            <span className={`text-[11px] ${status.kind === "ok" ? "text-ok" : "text-err"}`}>
              {status.kind === "ok" ? "✓ " : ""}
              {status.message}
            </span>
          )}
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
      <div className="flex gap-1">
        <input
          type="text"
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
          }}
          placeholder="/Users/you/repos/novaflow"
          className="flex-1 px-2 py-1 font-mono text-xs border rounded bg-surface-2 border-border text-primary"
          required
          data-testid="projects-create-path"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void (async (): Promise<void> => {
              const picked = await trpcUIClient.uiPickDirectory.mutate({
                title: "Pick project dir",
                defaultPath: path || undefined,
              });
              if (picked) onPickedDir(picked);
            })()
          }
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
          className="w-full px-2 py-1 text-xs border rounded bg-surface-2 border-border text-primary"
        />
      </Field>
      <Field label="RAG node (optional)">
        <select
          value={ragNode}
          onChange={(e) => {
            setRagNode(e.target.value);
          }}
          className="w-full px-2 py-1 text-xs border rounded bg-surface-2 border-border text-primary"
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
            className="w-full px-2 py-1 font-mono text-xs border rounded bg-surface-2 border-border text-primary"
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
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wide text-secondary">
        {label}
        {required && <span className="text-err">*</span>}
      </span>
      {children}
    </label>
  );
}
