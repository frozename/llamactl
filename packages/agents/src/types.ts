import type { z } from 'zod';

/**
 * Runbook contract. A runbook is a named, parameterized script that
 * chains MCP tool calls into an end-to-end operator flow. Runbooks
 * stay in TypeScript (not Markdown) so the harness can exercise each
 * one as a test and CI catches tool-surface drift before an operator
 * hits it in production.
 */

export interface RunbookStep {
  tool: string;
  dryRun: boolean;
  /** Arbitrary structured payload the runbook wants to record for this step. */
  result: unknown;
}

export interface RunbookResult {
  ok: boolean;
  steps: RunbookStep[];
  error?: string;
}

export interface ToolCallInput {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Thin client surface the harness hands to runbooks. Lets runbooks
 * stay decoupled from the MCP SDK shape so tests can inject a mock
 * without wiring a full server.
 */
export interface RunbookToolClient {
  callTool(input: ToolCallInput): Promise<unknown>;
}

export interface RunbookContext {
  tools: RunbookToolClient;
  /** When `true`, every mutation tool invocation passes `dryRun: true`
   *  so no state changes; the runbook still records what it would
   *  have done. */
  dryRun: boolean;
  log: (message: string) => void;
}

export interface Runbook<Params = void> {
  name: string;
  description: string;
  paramsSchema?: z.ZodType<Params>;
  execute(ctx: RunbookContext, params: Params): Promise<RunbookResult>;
}

/**
 * Parse a tool response's JSON text content into a typed payload.
 * Every llamactl-family MCP tool returns `{ content: [{ type: 'text',
 * text: <json> }] }`; runbooks unwrap that shape through this helper
 * so the details stay in one place.
 */
export function parseToolJson<T = unknown>(result: unknown): T {
  const content = (result as { content?: Array<{ type: string; text: string }> }).content ?? [];
  const text = content[0]?.text ?? 'null';
  return JSON.parse(text) as T;
}
