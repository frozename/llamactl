import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return i === 0 ? `${Math.trunc(x)} B` : `${x.toFixed(1)} ${units[i]}`;
}

export default function LMStudio(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [rootOverride, setRootOverride] = useState('');
  const [link, setLink] = useState(true);
  const [report, setReport] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const input = rootOverride.trim() ? { root: rootOverride.trim() } : undefined;
  const plan = trpc.lmstudioPlan.useQuery(
    rootOverride.trim() ? { root: rootOverride.trim(), link } : { link },
  );

  const importMutation = trpc.lmstudioImport.useMutation({
    onSuccess: async (result) => {
      const lines = [
        `root=${result.root ?? 'unknown'}`,
        `applied=${result.applied.length}`,
        `skipped=${result.skipped.length}`,
        `errors=${result.errors.length}`,
      ];
      setReport(lines.join(' '));
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: [['lmstudioPlan'], { type: 'query' }],
      });
      await queryClient.invalidateQueries({
        queryKey: [['catalogList'], { type: 'query' }],
      });
    },
    onError: (err) => {
      setError(err.message);
      setReport(null);
    },
  });

  const items = plan.data?.items ?? [];
  const root = plan.data?.root;
  const defaultRoot = plan.data?.defaultRoot;
  const busy = importMutation.isPending;
  const actionableCount = items.filter(
    (i) => i.action === 'link-and-add' || i.action === 'add',
  ).length;

  return (
    <div className="h-full overflow-auto p-6" data-testid="models-lmstudio-root">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-text-secondary)]">
        LM Studio
      </div>
      <h1 className="mb-4 text-2xl font-semibold text-[color:var(--color-text)]">
        Import models
      </h1>

      <form
        onSubmit={(e) => e.preventDefault()}
        className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
      >
        <div className="grid grid-cols-12 gap-3">
          <label className="col-span-7 text-sm">
            <span className="mb-1 block text-xs text-[color:var(--color-text-secondary)]">
              Root (optional override)
            </span>
            <input
              value={rootOverride}
              onChange={(e) => setRootOverride(e.target.value)}
              placeholder={root ?? defaultRoot ?? ''}
              disabled={busy}
              className="w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 mono"
            />
          </label>
          <label className="col-span-2 flex flex-col justify-end text-xs text-[color:var(--color-text-secondary)]">
            <span className="mb-1">Link</span>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={link}
                onChange={(e) => setLink(e.target.checked)}
                disabled={busy}
              />
              <span>symlink into $LLAMA_CPP_MODELS</span>
            </label>
          </label>
          <div className="col-span-3 flex items-end">
            <button
              type="button"
              onClick={() =>
                importMutation.mutate({
                  root: input?.root,
                  link,
                })
              }
              disabled={busy || actionableCount === 0}
              data-testid="lmstudio-import"
              className="w-full rounded bg-[var(--color-brand)] px-3 py-1 text-sm font-medium text-[color:var(--color-surface-0)] hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
              title={
                actionableCount === 0
                  ? 'No candidates ready to import — scan a root with .gguf files first.'
                  : `Import ${actionableCount} candidate${actionableCount === 1 ? '' : 's'} into $LLAMA_CPP_MODELS.`
              }
            >
              {busy
                ? 'Importing…'
                : actionableCount === 0
                  ? 'Nothing to import'
                  : `Import ${actionableCount}`}
            </button>
          </div>
        </div>
        <div className="mt-2 text-xs text-[color:var(--color-text-secondary)]">
          When link is on, each candidate becomes a symlink at
          $LLAMA_CPP_MODELS/&lt;rel&gt; so llamactl reads find it without copying gigabytes.
        </div>
      </form>

      {error && (
        <div className="mb-3 rounded-md border border-[var(--color-err)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-err)]">
          {error}
        </div>
      )}
      {report && (
        <div className="mb-3 rounded-md border border-[var(--color-ok)] bg-[var(--color-surface-1)] px-3 py-2 text-sm text-[color:var(--color-ok)]">
          {report}
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-text-secondary)]">
          Candidates ({items.length}){root ? ` — ${root}` : ''}
        </h2>
        {plan.isLoading ? (
          <div className="text-[color:var(--color-text-secondary)]">Scanning…</div>
        ) : !root ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
            No LM Studio install detected. Set LMSTUDIO_MODELS_DIR or supply a
            root override above.
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-text-secondary)]">
            No .gguf files found under {root}.
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
            <table className="w-full mono text-xs">
              <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-text-secondary)]">
                <tr>
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Rel</th>
                  <th className="px-3 py-2 font-medium">Size</th>
                  <th className="px-3 py-2 font-medium">Target</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.source.path}
                    className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                  >
                    <td className="px-3 py-1.5">
                      <span
                        className={
                          item.action.startsWith('skip')
                            ? 'text-[color:var(--color-text-secondary)]'
                            : 'text-[color:var(--color-ok)]'
                        }
                      >
                        {item.action}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[color:var(--color-brand)] break-all">
                      {item.rel}
                    </td>
                    <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)]">
                      {formatBytes(item.source.sizeBytes)}
                    </td>
                    <td className="px-3 py-1.5 text-[color:var(--color-text-secondary)] break-all">
                      {item.targetPath}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
