import * as React from "react";

import { Button, EditorialHero } from "@/ui";

import type { ProjectManifest } from "./types";

import { CreateProjectForm, ProjectDetail, ProjectRow } from "./components";
import { useProjects } from "./hooks";

/**
 * Projects module — the Electron surface for the trifold-
 * orchestrating-engelbart plan.
 */

export default function Projects(): React.JSX.Element {
  const { list, sorted, selected, setSelected, selectedProject } = useProjects();

  return (
    <div style={{ height: "100%", overflow: "auto", padding: 24 }} data-testid="projects-root">
      <div
        style={{
          marginBottom: 4,
          fontSize: 12,
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          color: "var(--color-text-secondary)",
        }}
      >
        Projects
      </div>
      <h1
        style={{
          marginBottom: 8,
          fontSize: 24,
          fontWeight: 600,
          color: "var(--color-text)",
        }}
      >
        Local projects
      </h1>
      <p
        style={{
          marginBottom: 24,
          fontSize: 12,
          color: "var(--color-text-secondary)",
        }}
      >
        Registered project directories with per-task routing policies.
      </p>

      {list.isLoading && <LoadingState />}
      {list.error && <ErrorState message={list.error.message} />}

      {!list.isLoading && !list.error && sorted.length === 0 && <ProjectsEmptyState />}

      {sorted.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <CreateProjectForm compact />
        </div>
      )}

      {sorted.length > 0 && (
        <ProjectsTable
          sorted={sorted}
          onOpenDetail={(name: string) => {
            setSelected(name);
          }}
        />
      )}

      {selectedProject && (
        <div>
          <ProjectDetail
            project={selectedProject}
            onClose={() => {
              setSelected(null);
            }}
            onRemoved={() => {
              setSelected(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function LoadingState(): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
        background: "var(--color-surface-1)",
        padding: 16,
        fontSize: 14,
        color: "var(--color-text-secondary)",
      }}
    >
      Loading projects…
    </div>
  );
}

function ErrorState({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      style={{
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "color:var(--color-err)",
        background: "var(--color-surface-1)",
        paddingLeft: 12,
        paddingRight: 12,
        paddingTop: 8,
        paddingBottom: 8,
        fontSize: 14,
        color: "var(--color-err)",
      }}
    >
      {message}
    </div>
  );
}

function ProjectsEmptyState(): React.JSX.Element {
  return (
    <div data-testid="projects-empty" style={{ marginTop: 16 }}>
      <EditorialHero
        title="New project"
        titleAccent="starts here"
        lede="Projects bundle workloads, prompts, and knowledge into one namespace."
        actions={
          <Button
            type="button"
            variant="primary"
            size="lg"
            onClick={() => {
              const el = document.querySelector<HTMLInputElement>(
                '[data-testid="projects-create-name"]',
              );
              el?.focus();
            }}
          >
            Create project
          </Button>
        }
      />
      <CreateProjectForm />
    </div>
  );
}

function ProjectsTable({
  sorted,
  onOpenDetail,
}: {
  sorted: ProjectManifest[];
  onOpenDetail: (name: string) => void;
}): React.JSX.Element {
  return (
    <div
      style={{
        overflow: "hidden",
        borderRadius: "var(--r-md)",
        border: "1px solid var(--color-border)",
        borderColor: "var(--color-border)",
      }}
      data-testid="projects-table"
    >
      <table style={{ width: "100%", fontSize: 14 }}>
        <thead
          style={{
            background: "var(--color-surface-1)",
            textAlign: "left",
            color: "var(--color-text-secondary)",
          }}
        >
          <tr>
            <th style={{ width: 192, padding: "8px 12px", fontWeight: 500 }}>Name</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Path</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>RAG</th>
            <th style={{ padding: "8px 12px", fontWeight: 500 }}>Routing policy</th>
            <th style={{ padding: "8px 12px", fontWeight: 500, textAlign: "right" }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => (
            <ProjectRow
              key={p.metadata.name}
              project={p}
              onOpenDetail={() => {
                onOpenDetail(p.metadata.name);
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
