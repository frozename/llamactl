import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/**
 * llamactl-owned storage for project resources. Projects are a
 * first-class primitive: filesystem path + optional RAG target + a
 * task-kind → routing-target map. A project shifts llamactl from
 * "pick a node" into "pick a project, let the project pick the node"
 * via the routing policy.
 *
 * Stored in a dedicated YAML (default `~/.llamactl/projects.yaml`),
 * NOT inlined into kubeconfig — the project file versions
 * separately, and nothing about project resources leaks into the
 * cluster/node/user shapes the rest of the stack already consumes.
 *
 * Shape mirrors the sirius-providers.yaml pattern (single file, list
 * of resources, thin load/save/upsert/remove helpers). Routing
 * targets are strings ONLY at this layer — resolution happens later,
 * inside the router hook that expands `project:<name>/<taskKind>`
 * into the concrete target node.
 *
 * File format (YAML):
 *
 *     apiVersion: llamactl/v1
 *     kind: ProjectList
 *     projects:
 *       - apiVersion: llamactl/v1
 *         kind: Project
 *         metadata: { name: novaflow }
 *         spec:
 *           path: /Users/me/code/novaflow
 *           purpose: NestJS + Next.js + Prisma + BullMQ monorepo
 *           stack: [nestjs, nextjs, prisma]
 *           rag:
 *             node: kb-chroma
 *             collection: novaflow_docs
 *             docsGlob: docs/**\/*.md
 *           routing:
 *             quick_qna: private-first
 *             code_review: mac-mini.claude-pro
 *           budget:
 *             usd_per_day: 2.50
 */

export const ProjectSchema = z.object({
  apiVersion: z.literal('llamactl/v1'),
  kind: z.literal('Project'),
  metadata: z.object({ name: z.string().min(1) }),
  spec: z.object({
    /** Absolute path on the operator's filesystem. String-validated
     *  only — we do NOT `fs.existsSync` here because the manifest
     *  might land on a machine where the path is meaningful via a
     *  different mount, and lookups at apply time would be wrong. */
    path: z.string().min(1),
    /** Free-form text injected into the chat system prompt when the
     *  project is the active chat scope. Optional — short projects
     *  don't need it. */
    purpose: z.string().optional(),
    /** Informational tags. No enforcement. */
    stack: z.array(z.string()).default([]),
    rag: z
      .object({
        node: z.string().min(1),
        collection: z.string().min(1),
        /** Relative to `spec.path`. Matches whatever the
         *  filesystem-source RagPipeline fetcher accepts. */
        docsGlob: z.string().default('docs/**/*.md'),
        /** Cron-style schedule grammar shared with RagPipeline. */
        schedule: z.string().optional(),
      })
      .optional(),
    /** task-kind → routing-target. Target is a free-form string:
     *  a node name (`mac-mini.claude-pro`), a synthetic model
     *  (`private-first`), or a `cli:<binding>` reference. Resolution
     *  is the router hook's job; this layer never validates that
     *  the target actually exists. */
    routing: z.record(z.string(), z.string()).default({}),
    budget: z
      .object({
        usd_per_day: z.number().min(0).optional(),
        cli_calls_per_day: z.record(z.string(), z.number().int().min(0)).optional(),
      })
      .optional(),
  }),
});
export type Project = z.infer<typeof ProjectSchema>;

const ProjectFileSchema = z.object({
  apiVersion: z.literal('llamactl/v1').default('llamactl/v1'),
  kind: z.literal('ProjectList').default('ProjectList'),
  projects: z.array(ProjectSchema).default([]),
});
type ProjectFile = z.infer<typeof ProjectFileSchema>;

/**
 * Resolve the projects-file path. Env override wins; otherwise
 * `$DEV_STORAGE/projects.yaml` (for dev-shadow workflows) or
 * `~/.llamactl/projects.yaml`.
 */
export function defaultProjectsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LLAMACTL_PROJECTS_FILE?.trim();
  if (override) return override;
  const base = env.DEV_STORAGE?.trim() || join(homedir(), '.llamactl');
  return join(base, 'projects.yaml');
}

export function loadProjects(
  path: string = defaultProjectsPath(),
): Project[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const parsed = ProjectFileSchema.parse(parseYaml(raw) ?? {});
  return parsed.projects;
}

export function saveProjects(
  projects: readonly Project[],
  path: string = defaultProjectsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const file: ProjectFile = {
    apiVersion: 'llamactl/v1',
    kind: 'ProjectList',
    projects: projects.map((p) => ProjectSchema.parse(p)),
  };
  writeFileSync(path, stringifyYaml(file), 'utf8');
}

export function upsertProject(
  projects: readonly Project[],
  entry: Project,
): Project[] {
  const filtered = projects.filter((p) => p.metadata.name !== entry.metadata.name);
  return [...filtered, entry];
}

export function removeProject(
  projects: readonly Project[],
  name: string,
): Project[] {
  return projects.filter((p) => p.metadata.name !== name);
}

/**
 * Resolve the routing target for a task kind against a project's
 * `spec.routing` map. No side effects, no node lookup — the caller
 * hands back whatever string is declared (or the default).
 *
 * Default fallback is the literal string `'private-first'` — the
 * same name the embersynth `private-first` profile answers to, so
 * an undeclared task kind naturally routes to the safest lane.
 */
export function resolveProjectRouting(
  project: Project,
  taskKind: string,
): { target: string; matched: boolean } {
  const target = project.spec.routing[taskKind];
  if (target) return { target, matched: true };
  return { target: 'private-first', matched: false };
}
