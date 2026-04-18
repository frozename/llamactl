import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';

/**
 * Nodes module. Shows every node in the current kubeconfig context,
 * with live probe results on demand. Supports:
 *   * Register a new node from a bootstrap blob pasted by the user
 *     (what `llamactl agent init` emits on the remote machine).
 *   * Test a node — fires nodeFacts across HTTPS + bearer to confirm
 *     the agent is actually reachable.
 *   * Remove a node — refuses the `local` entry, which is managed
 *     in-process.
 *
 * No node-switching yet: every other module still points at the
 * local router. H.3 will thread the selector through the stack.
 */

interface NodeFactsLite {
  nodeName: string;
  profile: string;
  platform: string;
  advertisedEndpoint?: string;
  memBytes?: number | null;
  gpu?: { kind: string; name?: string; memoryMB?: number } | null;
  versions?: { llamactl: string; bun: string };
}

function humanBytes(n: number | null | undefined): string {
  if (!n || n <= 0) return '—';
  const gb = n / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1024 / 1024)} MB`;
}

function RegisterPanel(props: { onDone: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const [blob, setBlob] = useState('');
  const [force, setForce] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const registerUtils = trpc.useUtils();

  const add = trpc.nodeAdd.useMutation({
    onSuccess: (result) => {
      setSuccess(`Registered ${result.name} → ${result.endpoint}`);
      setBlob('');
      setName('');
      void registerUtils.nodeList.invalidate();
      void queryClient.invalidateQueries();
      props.onDone();
    },
    onError: (err) => {
      setError(err.message);
      setSuccess(null);
    },
  });

  function submit(): void {
    setError(null);
    setSuccess(null);
    const n = name.trim();
    if (!n) {
      setError('Node name is required.');
      return;
    }
    const b = blob.trim();
    const match = /(?:--bootstrap\s+)?([A-Za-z0-9_-]+)\s*$/.exec(b);
    const pasted = match ? match[1]! : b;
    if (!pasted) {
      setError('Paste the bootstrap blob emitted by `llamactl agent init`.');
      return;
    }
    add.mutate({ name: n, bootstrap: pasted, force });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="mt-4 space-y-3 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4"
    >
      <div className="text-sm font-medium text-[color:var(--color-fg)]">
        Register a remote node
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="node name (e.g., mac-mini)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-sm text-[color:var(--color-fg)]"
        />
        <label className="flex items-center gap-1 text-xs text-[color:var(--color-fg-muted)]">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          skip reachability check
        </label>
      </div>
      <textarea
        placeholder="Paste the `llamactl node add <name> --bootstrap …` line or just the blob"
        value={blob}
        onChange={(e) => setBlob(e.target.value)}
        className="h-28 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-xs text-[color:var(--color-fg)]"
      />
      <div className="flex items-center gap-3 text-sm">
        <button
          type="submit"
          disabled={add.isPending}
          className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-3 py-1 text-[color:var(--color-fg-inverted)] disabled:opacity-50"
        >
          {add.isPending ? 'Registering…' : 'Register'}
        </button>
        {error && <span className="text-xs text-[color:var(--color-danger)]">{error}</span>}
        {success && <span className="text-xs text-[color:var(--color-success)]">{success}</span>}
      </div>
    </form>
  );
}

function NodeRow(props: {
  name: string;
  endpoint: string;
  defaultNode: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const [testResult, setTestResult] = useState<NodeFactsLite | string | null>(null);
  const [confirmRm, setConfirmRm] = useState(false);

  const test = trpc.nodeTest.useQuery(
    { name: props.name },
    { enabled: false, retry: false },
  );

  const remove = trpc.nodeRemove.useMutation({
    onSuccess: () => {
      setConfirmRm(false);
      void utils.nodeList.invalidate();
      void queryClient.invalidateQueries();
    },
  });

  async function runTest(): Promise<void> {
    setTestResult(null);
    const r = await test.refetch();
    if (r.data) {
      if (r.data.ok) setTestResult(r.data.facts as NodeFactsLite);
      else setTestResult(r.data.error);
    } else if (r.error) {
      setTestResult(r.error.message);
    }
  }

  const isLocal = props.name === 'local' || props.endpoint.startsWith('inproc://');
  const isDefault = props.name === props.defaultNode;

  return (
    <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3">
      <div className="flex items-baseline justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-sm text-[color:var(--color-fg)]">{props.name}</span>
          {isDefault && (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-muted)]">
              default
            </span>
          )}
          {isLocal && (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-muted)]">
              local
            </span>
          )}
        </div>
        <div className="flex gap-1 text-xs">
          <button
            type="button"
            onClick={runTest}
            disabled={test.isFetching}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg)] disabled:opacity-50"
          >
            {test.isFetching ? 'Testing…' : 'Test'}
          </button>
          {!isLocal && (
            <>
              {confirmRm ? (
                <>
                  <button
                    type="button"
                    onClick={() => remove.mutate({ name: props.name })}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-danger)] px-2 py-1 text-[color:var(--color-fg-inverted)]"
                  >
                    Confirm remove
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmRm(false)}
                    className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg)]"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRm(true)}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg-muted)]"
                >
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="mt-1 text-xs text-[color:var(--color-fg-muted)]">
        endpoint: <span className="font-mono">{props.endpoint}</span>
      </div>
      {testResult && (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-xs">
          {typeof testResult === 'string' ? (
            <span className="text-[color:var(--color-danger)]">{testResult}</span>
          ) : (
            <div className="space-y-0.5 font-mono text-[color:var(--color-fg)]">
              <div>profile: {testResult.profile}</div>
              <div>platform: {testResult.platform}</div>
              <div>memory: {humanBytes(testResult.memBytes)}</div>
              {testResult.gpu && (
                <div>
                  gpu: {testResult.gpu.kind}
                  {testResult.gpu.name ? ` — ${testResult.gpu.name}` : ''}
                </div>
              )}
              {testResult.advertisedEndpoint && (
                <div>advertised: {testResult.advertisedEndpoint}</div>
              )}
              {testResult.versions && (
                <div>
                  versions: llamactl {testResult.versions.llamactl} / bun {testResult.versions.bun}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Nodes(): React.JSX.Element {
  const list = trpc.nodeList.useQuery();
  const [showRegister, setShowRegister] = useState(false);

  if (list.isLoading) {
    return (
      <div className="p-6 text-sm text-[color:var(--color-fg-muted)]">Loading…</div>
    );
  }
  if (list.error) {
    return (
      <div className="p-6 text-sm text-[color:var(--color-danger)]">
        Failed to load nodes: {list.error.message}
      </div>
    );
  }
  const data = list.data!;
  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-baseline justify-between">
        <div>
          <h1 className="text-lg font-semibold text-[color:var(--color-fg)]">Nodes</h1>
          <div className="text-xs text-[color:var(--color-fg-muted)]">
            context <span className="font-mono">{data.context}</span> · cluster{' '}
            <span className="font-mono">{data.cluster}</span> · default{' '}
            <span className="font-mono">{data.defaultNode}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowRegister((v) => !v)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[color:var(--color-fg)]"
        >
          {showRegister ? 'Cancel' : 'Register node'}
        </button>
      </div>
      {showRegister && <RegisterPanel onDone={() => setShowRegister(false)} />}
      <div className="space-y-2">
        {data.nodes.length === 0 && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-xs text-[color:var(--color-fg-muted)]">
            (no nodes registered)
          </div>
        )}
        {data.nodes.map((n) => (
          <NodeRow
            key={n.name}
            name={n.name}
            endpoint={n.endpoint}
            defaultNode={data.defaultNode}
          />
        ))}
      </div>
    </div>
  );
}
