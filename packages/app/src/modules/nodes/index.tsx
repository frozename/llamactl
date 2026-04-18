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

type CloudProvider =
  | 'openai'
  | 'anthropic'
  | 'together'
  | 'groq'
  | 'mistral'
  | 'openai-compatible'
  | 'sirius';

function RegisterCloudPanel(props: { onDone: () => void }): React.JSX.Element {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<CloudProvider>('openai');
  const [apiKeyRef, setApiKeyRef] = useState('$OPENAI_API_KEY');
  const [baseUrl, setBaseUrl] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const add = trpc.nodeAddCloud.useMutation({
    onSuccess: (result) => {
      setSuccess(`Registered cloud node ${result.name} → ${result.baseUrl}`);
      setError(null);
      setName('');
      void utils.nodeList.invalidate();
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
    if (!name.trim()) {
      setError('Node name is required.');
      return;
    }
    const requiresKey = provider !== 'sirius' && provider !== 'openai-compatible';
    if (requiresKey && !apiKeyRef.trim()) {
      setError('apiKeyRef is required (e.g. $OPENAI_API_KEY or ~/.llamactl/keys/openai).');
      return;
    }
    add.mutate({
      name: name.trim(),
      provider,
      ...(apiKeyRef.trim() ? { apiKeyRef: apiKeyRef.trim() } : {}),
      ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
    });
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
        Register a cloud provider
        <span className="ml-2 text-[10px] text-[color:var(--color-fg-muted)]">
          (OpenAI / Anthropic / Together / groq / Mistral / any OpenAI-compat)
        </span>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <input
          type="text"
          placeholder="node name (e.g. openai-prod)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-48 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg)]"
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as CloudProvider)}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg)]"
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="together">together</option>
          <option value="groq">groq</option>
          <option value="mistral">mistral</option>
          <option value="openai-compatible">openai-compatible (custom)</option>
          <option value="sirius">sirius (gateway)</option>
        </select>
        <input
          type="text"
          placeholder="baseUrl (blank to use provider default)"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[color:var(--color-fg)]"
        />
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <input
          type="text"
          placeholder="apiKeyRef ($ENV_VAR or file path)"
          value={apiKeyRef}
          onChange={(e) => setApiKeyRef(e.target.value)}
          className="w-72 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[color:var(--color-fg)]"
        />
        <input
          type="text"
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1 text-[color:var(--color-fg)]"
        />
      </div>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="submit"
          disabled={add.isPending}
          className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-3 py-1 text-[color:var(--color-fg-inverted)] disabled:opacity-50"
        >
          {add.isPending ? 'Probing…' : 'Register cloud node'}
        </button>
        {error && <span className="text-xs text-[color:var(--color-danger)]">{error}</span>}
        {success && <span className="text-xs text-[color:var(--color-success)]">{success}</span>}
      </div>
    </form>
  );
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

function OpenAIConfigPanel(props: { node: string }): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const cfg = trpc.nodeOpenAIConfig.useQuery(
    { name: props.node },
    { enabled: false, retry: false, staleTime: Infinity },
  );

  async function load(): Promise<void> {
    if (!cfg.data) await cfg.refetch();
    setRevealed((v) => !v);
  }

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Non-secure contexts silently fail; the textarea is still
      // selectable by hand in that case.
    }
  }

  const pyExample = cfg.data
    ? `from openai import OpenAI\nclient = OpenAI(\n    base_url="${cfg.data.baseUrl}",\n    api_key="${cfg.data.apiKey}",\n)\n# For a self-signed CA, point NODE_EXTRA_CA_CERTS or\n# httpx verify=... at the PEM below.`
    : '';

  const curlExample = cfg.data
    ? `curl --cacert /path/to/ca.pem \\\n  -H "Authorization: Bearer ${cfg.data.apiKey}" \\\n  ${cfg.data.baseUrl}/models`
    : '';

  return (
    <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="font-medium text-[color:var(--color-fg)]">OpenAI config</span>
        <button
          type="button"
          onClick={() => { void load(); }}
          disabled={cfg.isFetching}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-0.5 text-[10px] text-[color:var(--color-fg)] disabled:opacity-50"
        >
          {cfg.isFetching ? 'Loading…' : revealed ? 'Hide' : 'Reveal'}
        </button>
      </div>
      {cfg.error && (
        <div className="mt-1 text-[color:var(--color-danger)]">{cfg.error.message}</div>
      )}
      {revealed && cfg.data && (
        <div className="mt-2 space-y-2 font-mono text-[11px] text-[color:var(--color-fg)]">
          <div>
            <div className="text-[10px] text-[color:var(--color-fg-muted)]">base_url</div>
            <div className="flex items-center gap-2">
              <span className="break-all">{cfg.data.baseUrl}</span>
              <button
                type="button"
                onClick={() => { void copy(cfg.data!.baseUrl); }}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1.5 py-0.5 text-[9px] text-[color:var(--color-fg-muted)]"
              >
                copy
              </button>
            </div>
          </div>
          <div>
            <div className="text-[10px] text-[color:var(--color-fg-muted)]">api_key (bearer)</div>
            <div className="flex items-center gap-2">
              <span className="break-all">{cfg.data.apiKey}</span>
              <button
                type="button"
                onClick={() => { void copy(cfg.data!.apiKey); }}
                className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1.5 py-0.5 text-[9px] text-[color:var(--color-fg-muted)]"
              >
                copy
              </button>
            </div>
          </div>
          {cfg.data.caCertPem && (
            <div>
              <div className="flex items-center justify-between text-[10px] text-[color:var(--color-fg-muted)]">
                <span>ca_cert.pem (fingerprint {cfg.data.caFingerprint ?? '—'})</span>
                <button
                  type="button"
                  onClick={() => { void copy(cfg.data!.caCertPem ?? ''); }}
                  className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-1.5 py-0.5 text-[9px] text-[color:var(--color-fg-muted)]"
                >
                  copy PEM
                </button>
              </div>
              <textarea
                readOnly
                value={cfg.data.caCertPem}
                className="mt-1 h-20 w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-[10px] text-[color:var(--color-fg)]"
              />
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-[10px] text-[color:var(--color-fg-muted)]">
              Python example
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-[10px]">
              {pyExample}
            </pre>
          </details>
          <details>
            <summary className="cursor-pointer text-[10px] text-[color:var(--color-fg-muted)]">
              curl example
            </summary>
            <pre className="mt-1 overflow-x-auto whitespace-pre rounded border border-[var(--color-border)] bg-[var(--color-surface-0)] px-2 py-1 text-[10px]">
              {curlExample}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function NodeRow(props: {
  name: string;
  endpoint: string;
  defaultNode: string;
  kind: 'agent' | 'cloud';
  cloud?: {
    provider: string;
    baseUrl: string;
    displayName?: string;
  } | null;
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
  const isCloud = props.kind === 'cloud';

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
          {isCloud && (
            <span className="rounded border border-[var(--color-border)] bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] text-[color:var(--color-fg-inverted)]">
              cloud · {props.cloud?.provider ?? '?'}
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
        {isCloud ? 'baseUrl' : 'endpoint'}:{' '}
        <span className="font-mono">
          {isCloud ? props.cloud?.baseUrl ?? '(missing)' : props.endpoint}
        </span>
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
      {!isLocal && <OpenAIConfigPanel node={props.name} />}
    </div>
  );
}

function DiscoverPanel(): React.JSX.Element {
  const discover = trpc.nodeDiscover.useQuery(
    { timeoutMs: 3000 },
    { enabled: false, retry: false, staleTime: 30_000 },
  );

  function scan(): void {
    void discover.refetch();
  }

  const rows = discover.data ?? [];
  return (
    <div className="mt-4 space-y-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[color:var(--color-fg)]">
          Discover LAN agents
          <span className="ml-2 text-[10px] text-[color:var(--color-fg-muted)]">(mDNS / Bonjour)</span>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={discover.isFetching}
          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[color:var(--color-fg)] disabled:opacity-50"
        >
          {discover.isFetching ? 'Scanning…' : 'Scan (3s)'}
        </button>
      </div>
      {discover.error && (
        <div className="text-xs text-[color:var(--color-danger)]">
          {discover.error.message}
        </div>
      )}
      {discover.data && rows.length === 0 && (
        <div className="text-xs text-[color:var(--color-fg-muted)]">
          No agents found. Make sure the remote machine has <span className="font-mono">llamactl agent serve</span> running on the same network.
        </div>
      )}
      {rows.length > 0 && (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li
              key={`${r.host}:${r.port}`}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[color:var(--color-fg)]">{r.nodeName}</span>
                <span className="text-[10px] text-[color:var(--color-fg-muted)]">
                  {r.alreadyRegistered ? 'registered' : 'new'}
                  {r.version ? ` · v${r.version}` : ''}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-[color:var(--color-fg-muted)]">
                {r.url}
                {r.fingerprint && (
                  <>
                    <span className="mx-1">·</span>
                    <span title={r.fingerprint}>{r.fingerprint.slice(0, 20)}…</span>
                  </>
                )}
              </div>
              <div className="mt-1 text-[10px] text-[color:var(--color-fg-muted)]">
                To register: run <span className="font-mono">llamactl agent init</span> on {r.nodeName}, then paste the bootstrap above.
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function Nodes(): React.JSX.Element {
  const list = trpc.nodeList.useQuery();
  const [showRegister, setShowRegister] = useState(false);
  const [showDiscover, setShowDiscover] = useState(false);
  const [showCloud, setShowCloud] = useState(false);

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
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowDiscover((v) => !v)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[color:var(--color-fg)]"
          >
            {showDiscover ? 'Hide discover' : 'Discover'}
          </button>
          <button
            type="button"
            onClick={() => setShowCloud((v) => !v)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[color:var(--color-fg)]"
          >
            {showCloud ? 'Cancel cloud' : 'Register cloud'}
          </button>
          <button
            type="button"
            onClick={() => setShowRegister((v) => !v)}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-sm text-[color:var(--color-fg)]"
          >
            {showRegister ? 'Cancel' : 'Register agent'}
          </button>
        </div>
      </div>
      {showDiscover && <DiscoverPanel />}
      {showCloud && <RegisterCloudPanel onDone={() => setShowCloud(false)} />}
      {showRegister && <RegisterPanel onDone={() => setShowRegister(false)} />}
      <div className="space-y-2">
        {data.nodes.length === 0 && (
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-xs text-[color:var(--color-fg-muted)]">
            (no nodes registered)
          </div>
        )}
        {data.nodes.map((n) => {
          const kind = (n as { effectiveKind?: 'agent' | 'cloud' }).effectiveKind
            ?? (n.cloud ? 'cloud' : 'agent');
          return (
            <NodeRow
              key={n.name}
              name={n.name}
              endpoint={n.endpoint}
              defaultNode={data.defaultNode}
              kind={kind}
              cloud={n.cloud ?? null}
            />
          );
        })}
      </div>
    </div>
  );
}
