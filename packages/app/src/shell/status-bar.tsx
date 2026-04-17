import { trpc } from '@/lib/trpc';

export function StatusBar(): JSX.Element {
  const env = trpc.env.useQuery();
  const e = env.data;

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 mono text-xs text-[color:var(--color-fg-muted)]">
      <span>
        profile:<span className="ml-1 text-[color:var(--color-fg)]">{e?.LLAMA_CPP_MACHINE_PROFILE ?? '—'}</span>
      </span>
      <span>
        provider:<span className="ml-1 text-[color:var(--color-fg)]">{e?.LOCAL_AI_PROVIDER ?? '—'}</span>
      </span>
      <span>
        model:<span className="ml-1 text-[color:var(--color-fg)]">{e?.LOCAL_AI_MODEL ?? '—'}</span>
      </span>
      <span className="ml-auto">{e?.LOCAL_AI_PROVIDER_URL ?? ''}</span>
    </div>
  );
}
