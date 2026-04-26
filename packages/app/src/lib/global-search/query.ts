// packages/app/src/lib/global-search/query.ts
import type { ParsedQuery, SurfaceKind } from './types';

const SURFACE_ALIASES: Record<string, SurfaceKind> = {
  module: 'module',
  tab: 'tab-history',
  recent: 'tab-history',
  workload: 'workload',
  node: 'node',
  preset: 'preset',
  session: 'session',
  ops: 'session',
  knowledge: 'knowledge',
  kb: 'knowledge',
  log: 'logs',
  logs: 'logs',
};

export function parseQuery(input: string): ParsedQuery {
  const trimmed = input.trim();
  if (!trimmed) return { needle: '' };

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    const rest = trimmed.slice(colonIdx + 1).trim();
    if (SURFACE_ALIASES[prefix]) {
      return {
        needle: rest,
        surfaceFilter: SURFACE_ALIASES[prefix],
      };
    }
  }
  return { needle: trimmed };
}