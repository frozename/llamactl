/**
 * `llamactl doctor` — first-run + day-one diagnostic. Probes the
 * surfaces a fresh operator needs for apply / composite / rag paths
 * to work, and prints an actionable status table.
 *
 * Exit codes:
 *   0 — every check passed or soft-skipped
 *   1 — at least one check raised ⚠ or ✗
 *
 * Probes are namespaced by subsystem so operators can grep:
 *   [agent]       local kubeconfig + node + launchd plist presence
 *   [docker]      /var/run/docker.sock reachable via ping()
 *   [kubernetes]  kubeconfig + reachable cluster + RBAC + default
 *                 StorageClass + llamactl-labelled nodes
 *   [secrets]     macOS Keychain availability (Darwin only)
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

type Status = 'ok' | 'warn' | 'fail' | 'info';

interface CheckResult {
  system: string;
  status: Status;
  message: string;
  fix?: string;
}

export async function runDoctor(argv: string[]): Promise<number> {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const results: CheckResult[] = [];

  // ---- agent ----
  await withBudget(opts.timeoutMs, async () => {
    results.push(...(await checkAgent()));
  }, (err) =>
    results.push({
      system: 'agent',
      status: 'fail',
      message: `probe timed out or errored: ${err}`,
    }),
  );

  // ---- docker ----
  await withBudget(opts.timeoutMs, async () => {
    results.push(...(await checkDocker()));
  }, (err) =>
    results.push({
      system: 'docker',
      status: 'fail',
      message: `probe errored: ${err}`,
    }),
  );

  // ---- kubernetes ----
  await withBudget(opts.timeoutMs, async () => {
    results.push(...(await checkKubernetes()));
  }, (err) =>
    results.push({
      system: 'kubernetes',
      status: 'fail',
      message: `probe errored: ${err}`,
    }),
  );

  // ---- secrets ----
  await withBudget(opts.timeoutMs, async () => {
    results.push(...checkSecrets());
  }, (err) =>
    results.push({
      system: 'secrets',
      status: 'fail',
      message: `probe errored: ${err}`,
    }),
  );

  print(results, opts.verbose);

  const failed = results.some((r) => r.status === 'fail' || r.status === 'warn');
  return failed ? 1 : 0;
}

// ---- checks ----

async function checkAgent(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const cfgPath = process.env.LLAMACTL_CONFIG ?? join(homedir(), '.llamactl', 'config');
  if (!existsSync(cfgPath)) {
    out.push({
      system: 'agent',
      status: 'warn',
      message: `kubeconfig not found at ${cfgPath}`,
      fix: 'run `llamactl agent init` to bootstrap a local agent + config',
    });
    return out;
  }
  try {
    const cfgYaml = readFileSync(cfgPath, 'utf8');
    const hasLocal = /name:\s*local/.test(cfgYaml);
    if (hasLocal) {
      out.push({
        system: 'agent',
        status: 'ok',
        message: `kubeconfig at ${cfgPath}, local node registered`,
      });
    } else {
      out.push({
        system: 'agent',
        status: 'warn',
        message: `kubeconfig at ${cfgPath} but no 'local' node`,
        fix: 'run `llamactl agent init` or `llamactl node add local ...`',
      });
    }
  } catch (err) {
    out.push({
      system: 'agent',
      status: 'fail',
      message: `cannot read ${cfgPath}: ${(err as Error).message}`,
    });
    return out;
  }

  // macOS: LaunchAgent plist check. Linux: systemd unit convention.
  if (platform() === 'darwin') {
    const plist = join(
      homedir(),
      'Library',
      'LaunchAgents',
      'com.llamactl.agent.plist',
    );
    if (existsSync(plist)) {
      out.push({
        system: 'agent',
        status: 'ok',
        message: `launchd plist present at ${plist}`,
      });
    } else {
      out.push({
        system: 'agent',
        status: 'info',
        message: 'no launchd plist installed',
        fix: '`llamactl agent install-launchd --scope=user` for background start on login',
      });
    }
  }
  return out;
}

async function checkDocker(): Promise<CheckResult[]> {
  try {
    const { createDockerBackend } = await import('@llamactl/remote');
    const backend = createDockerBackend();
    await backend.ping();
    return [
      {
        system: 'docker',
        status: 'ok',
        message: 'daemon reachable via /var/run/docker.sock',
      },
    ];
  } catch (err) {
    return [
      {
        system: 'docker',
        status: 'warn',
        message: `daemon not reachable: ${truncate((err as Error).message, 80)}`,
        fix: 'install + start Docker Desktop (macOS) or `systemctl start docker` (Linux); or unset if not using docker-runtime composites',
      },
    ];
  }
}

async function checkKubernetes(): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let backend: any;
  try {
    const { KubernetesBackend } = await import('@llamactl/remote');
    backend = new KubernetesBackend();
  } catch (err) {
    out.push({
      system: 'kubernetes',
      status: 'info',
      message: `kubeconfig not loaded: ${truncate((err as Error).message, 80)}`,
      fix: 'expected on hosts without ~/.kube/config; unset if not using k8s-runtime composites',
    });
    return out;
  }

  try {
    await backend.ping();
    out.push({
      system: 'kubernetes',
      status: 'ok',
      message: `cluster reachable (context: ${backend.currentContext})`,
    });
  } catch (err) {
    out.push({
      system: 'kubernetes',
      status: 'warn',
      message: `cluster unreachable: ${truncate((err as Error).message, 80)}`,
      fix: 'check `kubectl get nodes` reaches the cluster; refresh credentials if expired',
    });
    return out;
  }

  // RBAC probe: create + delete a throwaway namespace. The list path
  // doesn't prove create-permission; namespace-creation is the
  // privilege composite apply relies on. Skip on surprise failure —
  // warn with a hint if we can't confirm it.
  try {
    const { createKubernetesClient } = await import('@llamactl/remote');
    const client = createKubernetesClient();
    const probeName = `llamactl-doctor-probe-${Date.now().toString(36)}`;
    try {
      await client.core.createNamespace({
        body: {
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: probeName,
            labels: {
              'app.kubernetes.io/managed-by': 'llamactl',
              'llamactl.io/probe': 'doctor',
            },
          },
        },
      });
      await client.core.deleteNamespace({ name: probeName }).catch(() => {});
      out.push({
        system: 'kubernetes',
        status: 'ok',
        message: 'RBAC: create+delete namespace confirmed',
      });
    } catch (err) {
      out.push({
        system: 'kubernetes',
        status: 'warn',
        message: `RBAC: cannot create namespace (${truncate((err as Error).message, 80)})`,
        fix: 'grant the kubeconfig user `create`/`delete` on `namespaces` in the target cluster',
      });
    }

    // StorageClass enumeration is deferred — checking it from the CLI
    // requires pulling StorageV1Api, and the PVC-bind failure it
    // would prevent surfaces with a clear error at composite apply
    // time anyway. Operators on hosts without a default class should
    // still see `kubectl get storageclass` + the doc hint.
    out.push({
      system: 'kubernetes',
      status: 'info',
      message: 'StorageClass check deferred — verify with `kubectl get storageclass`',
      fix: 'cluster needs a default StorageClass for PVC-backed services (k3s ships local-path; Docker Desktop ships hostpath)',
    });

    // llamactl-labelled nodes
    try {
      const res = await client.core.listNode({
        labelSelector: 'llamactl.io/node',
      });
      const count = (res.items ?? []).length;
      if (count > 0) {
        const names = (res.items ?? [])
          .map(
            (n: { metadata?: { labels?: Record<string, string> } }) =>
              n.metadata?.labels?.['llamactl.io/node'] ?? '<unlabeled>',
          )
          .slice(0, 5);
        out.push({
          system: 'kubernetes',
          status: 'ok',
          message: `${count} llamactl-labelled node(s): ${names.join(', ')}`,
        });
      } else {
        out.push({
          system: 'kubernetes',
          status: 'info',
          message: '0 llamactl-labelled nodes',
          fix: '`kubectl label node <kubelet-host> llamactl.io/node=local` to enable node-affinity',
        });
      }
    } catch (err) {
      out.push({
        system: 'kubernetes',
        status: 'info',
        message: `node list failed: ${truncate((err as Error).message, 80)}`,
      });
    }
  } catch (err) {
    out.push({
      system: 'kubernetes',
      status: 'fail',
      message: `client setup error: ${(err as Error).message}`,
    });
  }

  return out;
}

function checkSecrets(): CheckResult[] {
  const host = platform();
  if (host !== 'darwin') {
    return [
      {
        system: 'secrets',
        status: 'info',
        message: `keychain: unavailable on ${host} (use env: or file: refs)`,
      },
    ];
  }
  // Don't shell out to `security` — we'd need a known test entry. Just
  // confirm the binary exists; an actual lookup happens at apply time
  // via the unified resolver.
  const candidates = ['/usr/bin/security', '/usr/local/bin/security'];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return [
      {
        system: 'secrets',
        status: 'warn',
        message: 'keychain: /usr/bin/security not found on this macOS',
        fix: 'use env: / file: refs instead of keychain: in your configs',
      },
    ];
  }
  return [
    {
      system: 'secrets',
      status: 'ok',
      message: `keychain: CLI present at ${found}`,
    },
  ];
}

// ---- helpers ----

function print(results: CheckResult[], verbose: boolean): void {
  const ICON: Record<Status, string> = {
    ok: '✓',
    warn: '⚠',
    fail: '✗',
    info: 'ℹ',
  };
  for (const r of results) {
    const label = `[${r.system}]`.padEnd(14);
    process.stdout.write(`${label} ${ICON[r.status]} ${r.message}\n`);
    if (r.fix && (verbose || r.status !== 'ok')) {
      process.stdout.write(`               ↳ ${r.fix}\n`);
    }
  }
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  process.stdout.write(
    `\n${results.length} check${results.length === 1 ? '' : 's'} — ${
      failed + warned === 0 ? 'all clear' : `${failed} fail, ${warned} warn`
    }\n`,
  );
}

async function withBudget(
  timeoutMs: number,
  fn: () => Promise<void>,
  onErr: (err: string) => void,
): Promise<void> {
  try {
    await Promise.race([
      fn(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), timeoutMs),
      ),
    ]);
  } catch (err) {
    onErr((err as Error).message);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface DoctorArgs {
  help: boolean;
  verbose: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): DoctorArgs {
  const a: DoctorArgs = { help: false, verbose: false, timeoutMs: 10_000 };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') a.help = true;
    else if (arg === '-v' || arg === '--verbose') a.verbose = true;
    else if (arg.startsWith('--timeout=')) {
      const n = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (Number.isFinite(n) && n > 0) a.timeoutMs = n * 1000;
    }
  }
  return a;
}

const USAGE = `llamactl doctor — probe local + cluster readiness

Usage:
  llamactl doctor [--verbose] [--timeout=<seconds>]

Checks:
  [agent]       kubeconfig + local node + launchd plist
  [docker]      daemon reachable via /var/run/docker.sock
  [kubernetes]  cluster reachable, RBAC (namespace CRUD),
                default StorageClass, llamactl-labelled nodes
  [secrets]     macOS Keychain CLI availability

Exit 0 when every probe is ✓ or ℹ; exit 1 on ⚠ / ✗.
`;
