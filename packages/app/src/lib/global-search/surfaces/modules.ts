// packages/app/src/lib/global-search/surfaces/modules.ts
import type { Hit } from '../types';

export const APP_MODULES = [
  { id: 'module:dashboard', title: 'Dashboard', keywords: 'home overview' },
  { id: 'module:workloads', title: 'Workloads', keywords: 'apps deployments services containers' },
  { id: 'module:nodes', title: 'Nodes', keywords: 'infrastructure servers agents gateways providers' },
  { id: 'module:ops-sessions', title: 'Ops Sessions', keywords: 'chat logs history' },
  { id: 'module:pipelines', title: 'RAG Pipelines', keywords: 'ingestion crawling embeddings' },
  { id: 'module:knowledge', title: 'Knowledge Base', keywords: 'kb documents files' },
  { id: 'module:composites', title: 'Composites', keywords: 'environments stacks templates' },
  { id: 'module:presets', title: 'Presets', keywords: 'models system prompts' },
  { id: 'module:pulls', title: 'Model Pulls', keywords: 'downloads images' },
  { id: 'module:logs', title: 'App Logs', keywords: 'diagnostics errors debug' },
  { id: 'module:bench', title: 'RAG Bench', keywords: 'evaluations tests scoring' },
  { id: 'module:cost', title: 'Cost & Usage', keywords: 'billing budget usage' },
  { id: 'module:settings', title: 'Settings', keywords: 'preferences config keys' },
];

export function matchModules(needle: string): Hit[] {
  if (!needle) return [];
  const lowered = needle.toLowerCase();
  const out: Hit[] = [];
  for (const m of APP_MODULES) {
    const blob = `${m.title} ${m.keywords}`.toLowerCase();
    if (!blob.includes(lowered)) continue;
    const startsWith = m.title.toLowerCase().startsWith(lowered);
    out.push({
      surface: 'module',
      parentId: m.id,
      parentTitle: m.title,
      score: startsWith ? 0.8 : 0.5,
      matchKind: 'exact',
      action: {
        kind: 'open-tab',
        tab: { tabKey: m.id, title: m.title, kind: 'module', openedAt: Date.now() },
      },
    });
  }
  return out;
}