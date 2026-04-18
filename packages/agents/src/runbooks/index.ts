import type { Runbook } from '../types.js';
import { promoteFastestVisionModel } from './promote-fastest-vision-model.js';

/**
 * Registry of known runbooks, keyed by name. New runbooks land here
 * as they come online. Keeping the registry in one file means the
 * CLI and the harness share a single source of truth for "what can
 * this harness run?"
 */
export const RUNBOOKS: Record<string, Runbook<never>> = {
  [promoteFastestVisionModel.name]: promoteFastestVisionModel as Runbook<never>,
};

export function listRunbooks(): Array<{ name: string; description: string }> {
  return Object.values(RUNBOOKS).map((r) => ({
    name: r.name,
    description: r.description,
  }));
}
