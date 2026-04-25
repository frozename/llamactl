import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, EditorialHero } from '@/ui';

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
    <div style={{ height: '100%', overflow: 'auto', padding: 24 }} data-testid="models-lmstudio-root">
      <div style={{ marginBottom: 4, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--color-text-secondary)' }}>
        LM Studio
      </div>
      <h1 style={{ marginBottom: 16, fontSize: 24, fontWeight: 600, color: 'var(--color-text)' }}>
        Import models
      </h1>

      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ marginBottom: 16, borderRadius: 6, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, minmax(0, 1fr))', gap: 12 }}>
          <label style={{ gridColumn: 'span 7 / span 7', fontSize: 14 }}>
            <span style={{ marginBottom: 4, display: 'block', fontSize: 12, color: 'var(--color-text-secondary)' }}>
              Root (optional override)
            </span>
            <Input
              value={rootOverride}
              onChange={(e) => setRootOverride(e.target.value)}
              placeholder={root ?? defaultRoot ?? ''}
              disabled={busy}
              style={{ width: '100%', fontFamily: 'monospace' }}
            />
          </label>
          <label style={{ gridColumn: 'span 2 / span 2', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', fontSize: 12, color: 'var(--color-text-secondary)' }}>
            <span style={{ marginBottom: 4 }}>Link</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input
                type="checkbox"
                checked={link}
                onChange={(e) => setLink(e.target.checked)}
                disabled={busy}
              />
              <span>symlink into $LLAMA_CPP_MODELS</span>
            </label>
          </label>
          <div style={{ gridColumn: 'span 3 / span 3', display: 'flex', alignItems: 'flex-end' }}>
            <Button
              variant="primary"
              onClick={() =>
                importMutation.mutate({
                  root: input?.root,
                  link,
                })
              }
              disabled={busy || actionableCount === 0}
              data-testid="lmstudio-import"
              style={{ width: '100%' }}
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
            </Button>
          </div>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          When link is on, each candidate becomes a symlink at
          $LLAMA_CPP_MODELS/&lt;rel&gt; so llamactl reads find it without copying gigabytes.
        </div>
      </form>

      {error && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-err)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-err)' }}>
          {error}
        </div>
      )}
      {report && (
        <div style={{ marginBottom: 12, borderRadius: 6, border: '1px solid var(--color-ok)', backgroundColor: 'var(--color-surface-1)', padding: '8px 12px', fontSize: 14, color: 'var(--color-ok)' }}>
          {report}
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: 8, fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)' }}>
          Candidates ({items.length}){root ? ` — ${root}` : ''}
        </h2>
        {plan.isLoading ? (
          <div style={{ color: 'var(--color-text-secondary)' }}>Scanning…</div>
        ) : !root ? (
          <EditorialHero
            title="No LM Studio install detected"
            lede="Set LMSTUDIO_MODELS_DIR or supply a root override above."
          />
        ) : items.length === 0 ? (
          <EditorialHero
            title={`No .gguf files found under ${root}`}
            lede="Ensure the directory exists and contains valid model files."
          />
        ) : (
          <div style={{ overflow: 'hidden', borderRadius: 6, border: '1px solid var(--color-border)' }}>
            <table style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}>
              <thead style={{ backgroundColor: 'var(--color-surface-1)', textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                <tr>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Action</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Rel</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Size</th>
                  <th style={{ padding: '8px 12px', fontWeight: 500 }}>Target</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.source.path}
                    style={{ borderTop: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)' }}
                  >
                    <td style={{ padding: '6px 12px' }}>
                      <span
                        style={{
                          color: item.action.startsWith('skip')
                            ? 'var(--color-text-secondary)'
                            : 'var(--color-ok)',
                        }}
                      >
                        {item.action}
                      </span>
                    </td>
                    <td style={{ padding: '6px 12px', color: 'var(--color-brand)', wordBreak: 'break-all' }}>
                      {item.rel}
                    </td>
                    <td style={{ padding: '6px 12px', color: 'var(--color-text-secondary)' }}>
                      {formatBytes(item.source.sizeBytes)}
                    </td>
                    <td style={{ padding: '6px 12px', color: 'var(--color-text-secondary)', wordBreak: 'break-all' }}>
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
