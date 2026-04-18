import { spawn } from 'node:child_process';
import { keepAlive } from '@llamactl/core';

const USAGE = `Usage: llamactl keep-alive <subcommand>

Subcommands:
  start <target> [--json]
      Launch a detached supervisor that keeps llama-server running,
      restarting it with exponential backoff (up to
      LLAMA_CPP_KEEP_ALIVE_MAX_BACKOFF seconds) when /health drops.
      Health is polled every LLAMA_CPP_KEEP_ALIVE_INTERVAL seconds
      (default 5).

  stop [--grace=<s>] [--json]
      Touch the supervisor's stop file and wait up to <grace> seconds
      before SIGTERM. The tracked llama-server is stopped too.

  status [--json]
      Report whether the supervisor is running and print its last
      state snapshot (target / model / state / restarts / backoff).

  worker <target> [--interval=<s>] [--max-backoff=<s>]
      Internal entry point run by \`start\` inside a detached bun
      subprocess. Invoking this directly blocks until the stop file
      is written or the process is terminated.
`;

async function runStart(args: string[]): Promise<number> {
  let json = false;
  const positional: string[] = [];
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else positional.push(arg);
  }
  const target = positional[0] ?? 'current';

  const existing = keepAlive.readKeepAlivePid();
  if (existing !== null) {
    const msg = `keep-alive already running (pid=${existing})`;
    if (json) process.stdout.write(`${JSON.stringify({ error: msg, pid: existing }, null, 2)}\n`);
    else process.stderr.write(`${msg}\n`);
    return 1;
  }

  // Spawn this same CLI as a detached worker. Use `process.execPath`
  // (bun) + argv[1] (bin.ts) so whether the user launched via shim or
  // `bun packages/cli/src/bin.ts`, the supervisor picks up the same
  // entry point.
  const bin = process.execPath;
  const entry = process.argv[1];
  if (!entry) {
    process.stderr.write('Cannot determine bin path for supervisor\n');
    return 1;
  }
  const child = spawn(bin, [entry, 'keep-alive', 'worker', target], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  // Wait briefly for the worker to write its pid file so the user's
  // `status` call immediately after start returns something useful.
  const startedAt = Date.now();
  let pid: number | null = null;
  while (Date.now() - startedAt < 2000) {
    pid = keepAlive.readKeepAlivePid();
    if (pid !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const report = {
    ok: pid !== null,
    pid,
    target,
    log: keepAlive.keepAliveLogFile(),
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    if (pid === null) {
      process.stderr.write('keep-alive supervisor did not register a PID within 2s\n');
    } else {
      process.stdout.write(
        `keep-alive started pid=${pid} target=${target} log=${report.log}\n`,
      );
    }
  }
  return pid !== null ? 0 : 1;
}

async function runStop(args: string[]): Promise<number> {
  let json = false;
  let graceSeconds = 10;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--grace=')) {
      const n = Number.parseInt(arg.slice('--grace='.length), 10);
      if (Number.isFinite(n) && n > 0) graceSeconds = n;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  const result = await keepAlive.stopKeepAlive({ graceSeconds });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `stopped pid=${result.pid ?? 'none'}${result.killed ? ' (SIGTERM)' : ''}\n`,
    );
  }
  return 0;
}

async function runStatus(args: string[]): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }
  const status = keepAlive.keepAliveStatus();
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.running ? 0 : 1;
  }
  process.stdout.write(
    `keep-alive: ${status.running ? `running (pid=${status.pid})` : 'stopped'}\n`,
  );
  if (status.state) {
    for (const [k, v] of Object.entries(status.state)) {
      process.stdout.write(`  ${k}=${String(v)}\n`);
    }
  }
  return status.running ? 0 : 1;
}

async function runWorker(args: string[]): Promise<number> {
  const positional: string[] = [];
  let intervalSeconds: number | undefined;
  let maxBackoff: number | undefined;
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--interval=')) {
      const n = Number.parseInt(arg.slice('--interval='.length), 10);
      if (Number.isFinite(n) && n > 0) intervalSeconds = n;
    } else if (arg.startsWith('--max-backoff=')) {
      const n = Number.parseInt(arg.slice('--max-backoff='.length), 10);
      if (Number.isFinite(n) && n > 0) maxBackoff = n;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else positional.push(arg);
  }
  const target = positional[0] ?? 'current';

  // Wire SIGTERM to a trip the abort signal so the loop exits cleanly
  // (allowing the `finally` cleanup to stop llama-server).
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    await keepAlive.runKeepAliveWorker({
      target,
      intervalSeconds,
      maxBackoff,
      signal: controller.signal,
    });
    return 0;
  } finally {
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
}

export async function runKeepAlive(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'start':
      return runStart(rest);
    case 'stop':
      return runStop(rest);
    case 'status':
      return runStatus(rest);
    case 'worker':
      return runWorker(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown keep-alive subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
