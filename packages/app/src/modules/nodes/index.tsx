import * as React from 'react';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { trpc } from '@/lib/trpc';
import { Button, Input, StatusDot, Badge, EditorialHero } from '@/ui';

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
  | 'sirius'
  | 'embersynth';

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
    const requiresKey =
      provider !== 'sirius' &&
      provider !== 'embersynth' &&
      provider !== 'openai-compatible';
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
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 4,
        border: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-surface-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>
        Register a cloud provider
        <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>
          (OpenAI / Anthropic / Together / groq / Mistral / any OpenAI-compat)
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <Input
          type="text"
          placeholder="node name (e.g. openai-prod)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 192 }}
        />
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as CloudProvider)}
          style={{
            borderRadius: 4,
            border: '1px solid var(--color-border)',
            backgroundColor: 'var(--color-surface-2)',
            padding: '4px 8px',
            color: 'var(--color-text)',
          }}
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
          <option value="together">together</option>
          <option value="groq">groq</option>
          <option value="mistral">mistral</option>
          <option value="openai-compatible">openai-compatible (custom)</option>
          <option value="sirius">sirius (gateway)</option>
          <option value="embersynth">embersynth (orchestrator)</option>
        </select>
        <Input
          type="text"
          placeholder="baseUrl (blank to use provider default)"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          style={{ flex: 1, fontFamily: 'monospace' }}
        />
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12 }}>
        <Input
          type="text"
          placeholder="apiKeyRef ($ENV_VAR or file path)"
          value={apiKeyRef}
          onChange={(e) => setApiKeyRef(e.target.value)}
          style={{ width: 288, fontFamily: 'monospace' }}
        />
        <Input
          type="text"
          placeholder="display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={{ flex: 1 }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={add.isPending}
        >
          {add.isPending ? 'Probing…' : 'Register cloud node'}
        </Button>
        {error && <span style={{ fontSize: 12, color: 'var(--color-err)' }}>{error}</span>}
        {success && <span style={{ fontSize: 12, color: 'var(--color-ok)' }}>{success}</span>}
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
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 4,
        border: '1px solid var(--color-border)',
        backgroundColor: 'var(--color-surface-1)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>
        Register a remote node
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Input
          type="text"
          placeholder="node name (e.g., mac-mini)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: 192 }}
        />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
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
        style={{
          height: 112,
          width: '100%',
          borderRadius: 4,
          border: '1px solid var(--color-border)',
          backgroundColor: 'var(--color-surface-2)',
          padding: '4px 8px',
          fontFamily: 'monospace',
          fontSize: 12,
          color: 'var(--color-text)',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14 }}>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={add.isPending}
        >
          {add.isPending ? 'Registering…' : 'Register'}
        </Button>
        {error && <span style={{ fontSize: 12, color: 'var(--color-err)' }}>{error}</span>}
        {success && <span style={{ fontSize: 12, color: 'var(--color-ok)' }}>{success}</span>}
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
    <div style={{ marginTop: 8, borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-2)', padding: 8, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontWeight: 500, color: 'var(--color-text)' }}>OpenAI config</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => { void load(); }}
          disabled={cfg.isFetching}
          style={{ fontSize: 10, padding: '2px 8px' }}
        >
          {cfg.isFetching ? 'Loading…' : revealed ? 'Hide' : 'Reveal'}
        </Button>
      </div>
      {cfg.error && (
        <div style={{ marginTop: 4, color: 'var(--color-err)' }}>{cfg.error.message}</div>
      )}
      {revealed && cfg.data && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'monospace', fontSize: 11, color: 'var(--color-text)' }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>base_url</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ wordBreak: 'break-all' }}>{cfg.data.baseUrl}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void copy(cfg.data!.baseUrl); }}
                style={{ fontSize: 9, padding: '2px 6px' }}
              >
                copy
              </Button>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>api_key (bearer)</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ wordBreak: 'break-all' }}>{cfg.data.apiKey}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { void copy(cfg.data!.apiKey); }}
                style={{ fontSize: 9, padding: '2px 6px' }}
              >
                copy
              </Button>
            </div>
          </div>
          {cfg.data.caCertPem && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                <span>ca_cert.pem (fingerprint {cfg.data.caFingerprint ?? '—'})</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => { void copy(cfg.data!.caCertPem ?? ''); }}
                  style={{ fontSize: 9, padding: '2px 6px' }}
                >
                  copy PEM
                </Button>
              </div>
              <textarea
                readOnly
                value={cfg.data.caCertPem}
                style={{ marginTop: 4, height: 80, width: '100%', borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-0)', padding: '4px 8px', fontSize: 10, color: 'var(--color-text)' }}
              />
            </div>
          )}
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--color-text-secondary)' }}>
              Python example
            </summary>
            <pre style={{ marginTop: 4, overflowX: 'auto', whiteSpace: 'pre', borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-0)', padding: '4px 8px', fontSize: 10 }}>
              {pyExample}
            </pre>
          </details>
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 10, color: 'var(--color-text-secondary)' }}>
              curl example
            </summary>
            <pre style={{ marginTop: 4, overflowX: 'auto', whiteSpace: 'pre', borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-0)', padding: '4px 8px', fontSize: 10 }}>
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
  kind: 'agent' | 'gateway' | 'provider';
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

  const isLocalNode = props.name === 'local' || props.endpoint.startsWith('inproc://');
  const probe = trpc.nodeTest.useQuery(
    { name: props.name },
    {
      enabled: !isLocalNode,
      refetchInterval: 30_000,
      retry: 0,
      staleTime: 15_000,
    },
  );
  const reachability: 'ok' | 'fail' | 'unknown' = isLocalNode
    ? 'ok'
    : probe.data?.ok === true
      ? 'ok'
      : probe.data?.ok === false || probe.isError
        ? 'fail'
        : 'unknown';
  const reachabilityTitle = isLocalNode
    ? 'in-process (always reachable)'
    : reachability === 'ok'
      ? 'reachable'
      : reachability === 'fail'
        ? (probe.data && 'error' in probe.data ? probe.data.error : undefined) ??
          probe.error?.message ??
          'unreachable'
        : 'probing…';

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

  const isLocal = isLocalNode;
  const isDefault = props.name === props.defaultNode;
  const isGateway = props.kind === 'gateway';
  const isProvider = props.kind === 'provider';

  return (
    <div style={{ borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <StatusDot
            tone={reachability === 'ok' ? 'ok' : reachability === 'fail' ? 'err' : 'idle'}
            data-testid={`node-health-${props.name}`}
            title={reachabilityTitle}
            style={{ transform: 'translateY(-1px)' }}
          />
          <span style={{ fontFamily: 'monospace', fontSize: 14, color: 'var(--color-text)' }}>{props.name}</span>
          {isDefault && (
            <Badge variant="default">default</Badge>
          )}
          {isLocal && (
            <Badge variant="default">local</Badge>
          )}
          {isGateway && (
            <Badge variant="brand">gateway · {props.cloud?.provider ?? '?'}</Badge>
          )}
          {isProvider && (
            <Badge variant="default" style={{ marginLeft: 16 }}>provider</Badge>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4, fontSize: 12 }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={runTest}
            disabled={test.isFetching}
          >
            {test.isFetching ? 'Testing…' : 'Test'}
          </Button>
          {!isLocal && !isProvider && (
            <>
              {confirmRm ? (
                <>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => remove.mutate({ name: props.name })}
                  >
                    Confirm remove
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmRm(false)}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmRm(true)}
                >
                  Remove
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div style={{ marginTop: 4, fontSize: 12, color: 'var(--color-text-secondary)' }}>
        {isProvider
          ? 'via gateway'
          : isGateway
            ? 'baseUrl'
            : 'endpoint'}:{' '}
        <span style={{ fontFamily: 'monospace' }}>
          {isProvider
            ? props.name.split('.')[0]
            : isGateway
              ? props.cloud?.baseUrl ?? '(missing)'
              : props.endpoint}
        </span>
      </div>
      {testResult && (
        <div style={{ marginTop: 8, borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-2)', padding: 8, fontSize: 12 }}>
          {typeof testResult === 'string' ? (
            <span style={{ color: 'var(--color-err)' }}>{testResult}</span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontFamily: 'monospace', color: 'var(--color-text)' }}>
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
      {!isLocal && !isProvider && <OpenAIConfigPanel node={props.name} />}
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
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8, borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-1)', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text)' }}>
          Discover LAN agents
          <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--color-text-secondary)' }}>(mDNS / Bonjour)</span>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={scan}
          disabled={discover.isFetching}
        >
          {discover.isFetching ? 'Scanning…' : 'Scan (3s)'}
        </Button>
      </div>
      {discover.error && (
        <div style={{ fontSize: 12, color: 'var(--color-err)' }}>
          {discover.error.message}
        </div>
      )}
      {discover.data && rows.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
          No agents found. Make sure the remote machine has <span style={{ fontFamily: 'monospace' }}>llamactl agent serve</span> running on the same network.
        </div>
      )}
      {rows.length > 0 && (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {rows.map((r) => (
            <li
              key={`${r.host}:${r.port}`}
              style={{ borderRadius: 4, border: '1px solid var(--color-border)', backgroundColor: 'var(--color-surface-2)', padding: '8px 12px', fontSize: 12 }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontFamily: 'monospace', color: 'var(--color-text)' }}>{r.nodeName}</span>
                <span style={{ fontSize: 10, color: 'var(--color-text-secondary)' }}>
                  {r.alreadyRegistered ? 'registered' : 'new'}
                  {r.version ? ` · v${r.version}` : ''}
                </span>
              </div>
              <div style={{ marginTop: 4, fontFamily: 'monospace', fontSize: 10, color: 'var(--color-text-secondary)' }}>
                {r.url}
                {r.fingerprint && (
                  <>
                    <span style={{ margin: '0 4px' }}>·</span>
                    <span title={r.fingerprint}>{r.fingerprint.slice(0, 20)}…</span>
                  </>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--color-text-secondary)' }}>
                To register: run <span style={{ fontFamily: 'monospace' }}>llamactl agent init</span> on {r.nodeName}, then paste the bootstrap above.
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
      <div style={{ height: '100%' }} data-testid="nodes-root">
        <div style={{ padding: 24, fontSize: 14, color: 'var(--color-text-secondary)' }}>Loading…</div>
      </div>
    );
  }
  if (list.error) {
    return (
      <div style={{ height: '100%' }} data-testid="nodes-root">
        <div style={{ padding: 24, fontSize: 14, color: 'var(--color-err)' }}>
          Failed to load nodes: {list.error.message}
        </div>
      </div>
    );
  }
  const data = list.data ?? { nodes: [], context: '', cluster: '', defaultNode: '' };
  return (
    <div style={{ display: 'flex', height: '100%', flexDirection: 'column', gap: 16, overflow: 'auto', padding: 24 }} data-testid="nodes-root">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: 'var(--color-text)' }}>Nodes</h1>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
            context <span style={{ fontFamily: 'monospace' }}>{data.context}</span> · cluster{' '}
            <span style={{ fontFamily: 'monospace' }}>{data.cluster}</span> · default{' '}
            <span style={{ fontFamily: 'monospace' }}>{data.defaultNode}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowDiscover((v) => !v)}
          >
            {showDiscover ? 'Hide discover' : 'Discover'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowCloud((v) => !v)}
          >
            {showCloud ? 'Cancel cloud' : 'Register cloud'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setShowRegister((v) => !v)}
          >
            {showRegister ? 'Cancel' : 'Register agent'}
          </Button>
        </div>
      </div>
      {showDiscover && <DiscoverPanel />}
      {showCloud && <RegisterCloudPanel onDone={() => setShowCloud(false)} />}
      {showRegister && <RegisterPanel onDone={() => setShowRegister(false)} />}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.nodes.length === 0 && (
          <EditorialHero title="No nodes registered" lede="Register a remote agent or a cloud provider to begin." />
        )}
        {data.nodes.map((n) => {
          const explicit = (n as { effectiveKind?: 'agent' | 'gateway' | 'provider' })
            .effectiveKind;
          const kind: 'agent' | 'gateway' | 'provider' =
            explicit ?? (n.cloud ? 'gateway' : 'agent');
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
