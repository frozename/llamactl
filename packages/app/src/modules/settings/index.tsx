import type { schemas } from '@llamactl/core';
import { trpc } from '@/lib/trpc';

type PresetOverride = schemas.PresetOverride;

const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: 'Paths',
    keys: [
      'DEV_STORAGE',
      'LLAMA_CPP_ROOT',
      'LLAMA_CPP_MODELS',
      'LLAMA_CPP_CACHE',
      'LLAMA_CPP_LOGS',
      'LLAMA_CPP_BIN',
      'LOCAL_AI_RUNTIME_DIR',
      'HF_HOME',
      'OLLAMA_MODELS',
    ],
  },
  {
    title: 'Machine',
    keys: [
      'LLAMA_CPP_MACHINE_PROFILE',
      'LLAMA_CPP_DEFAULT_MODEL',
      'LLAMA_CPP_GEMMA_CTX_SIZE',
      'LLAMA_CPP_QWEN_CTX_SIZE',
    ],
  },
  {
    title: 'Provider',
    keys: [
      'LOCAL_AI_PROVIDER',
      'LOCAL_AI_PROVIDER_URL',
      'LOCAL_AI_MODEL',
      'LOCAL_AI_SOURCE_MODEL',
      'LOCAL_AI_CONTEXT_LENGTH',
    ],
  },
  {
    title: 'Discovery',
    keys: [
      'LOCAL_AI_DISCOVERY_AUTHOR',
      'LOCAL_AI_DISCOVERY_LIMIT',
      'LOCAL_AI_DISCOVERY_SEARCH',
      'LOCAL_AI_RECOMMENDATIONS_SOURCE',
      'LOCAL_AI_HF_CACHE_TTL_SECONDS',
    ],
  },
  {
    title: 'Feature toggles',
    keys: [
      'LLAMA_CPP_AUTO_TUNE_ON_PULL',
      'LLAMA_CPP_AUTO_BENCH_VISION',
      'LOCAL_AI_ENABLE_THINKING',
      'LOCAL_AI_PRESERVE_THINKING',
    ],
  },
];

export default function Settings(): JSX.Element {
  const env = trpc.env.useQuery();
  const promotions = trpc.promotions.useQuery();

  if (env.isLoading) {
    return <div className="p-6 text-[color:var(--color-fg-muted)]">Loading…</div>;
  }
  const values = (env.data ?? {}) as Record<string, string>;

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1 text-xs uppercase tracking-widest text-[color:var(--color-fg-muted)]">
        Settings
      </div>
      <h1 className="mb-6 text-2xl font-semibold text-[color:var(--color-fg)]">Environment</h1>

      <div className="space-y-6">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
              {group.title}
            </h2>
            <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
              <table className="w-full mono text-sm">
                <tbody>
                  {group.keys.map((key) => (
                    <tr
                      key={key}
                      className="border-b border-[var(--color-border)] last:border-b-0 bg-[var(--color-surface-1)]"
                    >
                      <td className="w-72 px-3 py-1.5 text-[color:var(--color-fg-muted)]">
                        {key}
                      </td>
                      <td className="px-3 py-1.5 text-[color:var(--color-fg)] break-all">
                        {values[key] ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}

        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-[color:var(--color-fg-muted)]">
            Preset promotions ({promotions.data?.length ?? 0})
          </h2>
          {(promotions.data ?? []).length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-[color:var(--color-fg-muted)]">
              No active promotions. Use <span className="mono">llamactl catalog promote</span> to add one.
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-[var(--color-border)]">
              <table className="w-full mono text-sm">
                <thead className="bg-[var(--color-surface-1)] text-left text-[color:var(--color-fg-muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Profile</th>
                    <th className="px-3 py-2 font-medium">Preset</th>
                    <th className="px-3 py-2 font-medium">Rel</th>
                    <th className="px-3 py-2 font-medium">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {(promotions.data ?? []).map((p: PresetOverride) => (
                    <tr
                      key={`${p.profile}:${p.preset}`}
                      className="border-t border-[var(--color-border)] bg-[var(--color-surface-1)]"
                    >
                      <td className="px-3 py-2 text-[color:var(--color-brand)]">{p.profile}</td>
                      <td className="px-3 py-2">{p.preset}</td>
                      <td className="px-3 py-2 text-[color:var(--color-accent)] break-all">
                        {p.rel}
                      </td>
                      <td className="px-3 py-2 text-[color:var(--color-fg-muted)]">
                        {p.updated_at ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
