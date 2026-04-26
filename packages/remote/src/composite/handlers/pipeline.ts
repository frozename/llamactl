import { stringify as stringifyYaml } from 'yaml';
import { entrySpecHash } from '../../workload/gateway-catalog/hash.js';
import type {
  CompositeStatusComponent,
  PipelineCompositeEntry,
} from '../schema.js';

/**
 * Wire shape returned by `ragPipelineApply` when ownership is supplied.
 * Mirrors the procedure body in `router.ts` — note the field is `created`
 * (the operator-CLI wire shape predates the bridge and we keep it stable
 * across both call paths). The `name`/`shape` discriminant on `conflict`
 * matches `ApplyConflict` in `rag/pipeline/store.ts`.
 */
type RagPipelineApplyResult =
  | { ok: true; name: string; path: string; created: boolean }
  | {
      ok: false;
      name: string;
      conflict:
        | {
            kind: 'name';
            name: string;
            existingOwner: 'operator' | 'composite';
          }
        | { kind: 'shape'; name: string; reason: string };
    };

/**
 * Wire shape returned by `ragPipelineRemove` when `compositeName` is
 * supplied (composite-aware ref-counted path). The legacy `removed`
 * field is only emitted when no `compositeName` is passed, so the
 * handler never sees it.
 */
type RagPipelineRemoveResult =
  | { ok: true; deleted: boolean }
  | {
      ok: false;
      name: string;
      conflict: { kind: 'name'; name: string; existingOwner: 'operator' };
    };

export interface PipelineHandlerCtx {
  /** The composite's metadata.name — used as the ownership.compositeNames entry. */
  compositeName: string;
  /** In-process tRPC caller. Composite applier creates this once per apply. */
  caller: {
    ragPipelineApply: (input: {
      manifestYaml: string;
      ownership?: {
        source: 'composite';
        compositeNames: string[];
        specHash: string;
      };
    }) => Promise<RagPipelineApplyResult>;
    ragPipelineRun: (input: {
      name: string;
      dryRun?: boolean;
    }) => Promise<unknown>;
  };
  /** Optional logger for fire-and-forget first-run errors. Default: silent. */
  onFirstRunError?: (err: Error, name: string) => void;
}

export interface PipelineHandlerResult {
  status: CompositeStatusComponent;
  /** Whether applyPipeline reported the spec changed on disk this call. */
  changed: boolean;
}

/**
 * Apply a single pipeline component. Builds the RagPipeline manifest from
 * the entry, computes specHash, calls ragPipelineApply via the in-process
 * caller, and on success fires-and-forgets ragPipelineRun (first-run
 * trigger per spec D3).
 *
 * Conflicts ('name' / 'shape') translate to Pending status with the
 * canonical reason names so operators see consistent messaging.
 */
export async function applyPipelineComponent(
  entry: PipelineCompositeEntry,
  ctx: PipelineHandlerCtx,
): Promise<PipelineHandlerResult> {
  const manifest = {
    apiVersion: 'llamactl/v1' as const,
    kind: 'RagPipeline' as const,
    metadata: { name: entry.name },
    spec: entry.spec,
  };
  const specHash = entrySpecHash(entry.spec);
  const manifestYaml = stringifyYaml(manifest);

  const result = await ctx.caller.ragPipelineApply({
    manifestYaml,
    ownership: {
      source: 'composite',
      compositeNames: [ctx.compositeName],
      specHash,
    },
  });

  if (!result.ok) {
    const reasonMap: Record<string, string> = {
      name: 'PipelineNameCollision',
      shape: 'PipelineShapeMismatch',
    };
    const reason = reasonMap[result.conflict.kind] ?? 'PipelineConflict';
    const detail =
      result.conflict.kind === 'name'
        ? `pipeline '${result.conflict.name}' already exists as ${result.conflict.existingOwner}-managed`
        : `pipeline '${result.conflict.name}' shape disagrees with prior composite (${result.conflict.reason})`;
    return {
      changed: false,
      status: {
        ref: { kind: 'pipeline', name: entry.name },
        state: 'Pending',
        message: `${reason}: ${detail}`,
      },
    };
  }

  if (result.created) {
    // Fire-and-forget first run. Errors surface in the pipeline journal,
    // not in this handler — composite reaches Ready as soon as
    // registration succeeded.
    void ctx.caller.ragPipelineRun({ name: entry.name }).catch((err) => {
      ctx.onFirstRunError?.(err as Error, entry.name);
    });
  }

  return {
    changed: result.created,
    status: {
      ref: { kind: 'pipeline', name: entry.name },
      state: 'Ready',
    },
  };
}

/**
 * Tear-down for a single pipeline component owned by `compositeName`.
 * Calls removePipeline via the in-process caller with ref-counting.
 * On conflict (operator-owned pipeline collided with composite name)
 * we report `deleted: false` — composite destroy keeps moving.
 */
export async function removePipelineComponent(
  entry: PipelineCompositeEntry,
  ctx: {
    compositeName: string;
    caller: {
      ragPipelineRemove: (input: {
        name: string;
        compositeName?: string;
      }) => Promise<RagPipelineRemoveResult>;
    };
  },
): Promise<{ deleted: boolean }> {
  const result = await ctx.caller.ragPipelineRemove({
    name: entry.name,
    compositeName: ctx.compositeName,
  });
  if (!result.ok) {
    return { deleted: false };
  }
  return { deleted: result.deleted };
}
