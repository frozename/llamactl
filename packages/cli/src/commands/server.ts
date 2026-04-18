import { env as envMod, server, serverLogs as serverLogsMod } from '@llamactl/core';
import {
  getGlobals,
  getNodeClient,
  isLocalDispatch,
  matchDoneEvent,
  subscribeRemote,
} from '../dispatcher.js';

const USAGE = `Usage: llamactl server <subcommand>

Subcommands:
  start <target> [--timeout=<s>] [--no-tuned] [--json] [-- extra-args]
      Launch llama-server in the background with the tuned profile
      args (when available), wait for /health=200 up to <timeout>
      seconds (default 60), and record the PID. Everything after \`--\`
      is forwarded to llama-server as-is.

  stop [--grace=<s>] [--json]
      SIGTERM the tracked llama-server PID and escalate to SIGKILL
      after <grace> seconds (default 5).

  status [--json]
      Report whether llama-server is reachable at the configured
      endpoint and what PID (if any) is tracked.

  logs [--follow|-f] [--lines=<N>]
      Print the last N lines (default 50) of the server.log file. With
      --follow, keep streaming new lines until Ctrl-C. Against
      --node <remote>, tails the agent's log file over SSE.
`;

function forwardEvent(e: server.ServerEvent): void {
  switch (e.type) {
    case 'launch':
      process.stderr.write(`$ ${e.command} ${e.args.join(' ')}\n`);
      process.stderr.write(`launched pid=${e.pid}\n`);
      break;
    case 'waiting':
      // Quiet by default — a dot would help but spams stderr. Emit
      // one line every ~10 attempts so the user sees forward progress
      // without drowning in httpCode logs.
      if (e.attempt % 10 === 0) {
        process.stderr.write(
          `waiting ... attempt=${e.attempt} http=${e.httpCode ?? 'n/a'}\n`,
        );
      }
      break;
    case 'retry':
      process.stderr.write(`retrying: ${e.reason}\n`);
      break;
    case 'ready':
      process.stderr.write(`ready pid=${e.pid} endpoint=${e.endpoint}\n`);
      break;
    case 'timeout':
      process.stderr.write(`timeout pid=${e.pid}\n`);
      break;
    case 'exited':
      process.stderr.write(`exited code=${e.code ?? '?'}\n`);
      break;
  }
}

async function runStart(args: string[]): Promise<number> {
  const positional: string[] = [];
  const extra: string[] = [];
  let json = false;
  let skipTuned = false;
  let timeoutSeconds = 60;
  let sawDashDash = false;
  for (const arg of args) {
    if (sawDashDash) {
      extra.push(arg);
      continue;
    }
    if (arg === '--') {
      sawDashDash = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--no-tuned') {
      skipTuned = true;
    } else if (arg.startsWith('--timeout=')) {
      const n = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (Number.isFinite(n) && n > 0) timeoutSeconds = n;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    } else {
      positional.push(arg);
    }
  }
  const target = positional[0] ?? 'current';
  if (positional.length > 1) {
    process.stderr.write(
      `Extra positional args need to follow \`--\`: ${positional.slice(1).join(' ')}\n`,
    );
    return 1;
  }

  let result: Awaited<ReturnType<typeof server.startServer>>;
  if (isLocalDispatch()) {
    result = await server.startServer({
      target,
      extraArgs: extra,
      timeoutSeconds,
      skipTuned,
      onEvent: forwardEvent,
    });
  } else {
    try {
      const input: { target: string; extraArgs?: string[]; timeoutSeconds?: number; skipTuned?: boolean } = { target };
      if (extra.length > 0) input.extraArgs = extra;
      if (timeoutSeconds !== 60) input.timeoutSeconds = timeoutSeconds;
      if (skipTuned) input.skipTuned = skipTuned;
      result = await subscribeRemote<server.ServerEvent, Awaited<ReturnType<typeof server.startServer>>>({
        subscribe: (handlers) => getNodeClient().serverStart.subscribe(input, handlers),
        onEvent: forwardEvent,
        extractDone: matchDoneEvent<Awaited<ReturnType<typeof server.startServer>>>('done'),
      });
    } catch (err) {
      process.stderr.write(`server start: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!result.ok) {
    process.stderr.write(`${result.error ?? 'server failed to start'}\n`);
  } else {
    process.stdout.write(
      `llama-server up pid=${result.pid} endpoint=${result.endpoint}${result.tunedProfile ? ` tuned=${result.tunedProfile}` : ''}${result.retried ? ' (retried)' : ''}\n`,
    );
  }
  return result.ok ? 0 : 1;
}

async function runStop(args: string[]): Promise<number> {
  let json = false;
  let graceSeconds = 5;
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
  let result: Awaited<ReturnType<typeof server.stopServer>>;
  if (isLocalDispatch()) {
    result = await server.stopServer({ graceSeconds });
  } else {
    try {
      result = await getNodeClient().serverStop.mutate({ graceSeconds }) as typeof result;
    } catch (err) {
      process.stderr.write(`server stop: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `stopped pid=${result.pid ?? 'none'}${result.killed ? ' (SIGKILL)' : ''}\n`,
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
  let status: Awaited<ReturnType<typeof server.serverStatus>>;
  if (isLocalDispatch()) {
    const resolved = envMod.resolveEnv();
    status = await server.serverStatus(resolved);
  } else {
    try {
      status = await getNodeClient().serverStatus.query() as typeof status;
    } catch (err) {
      process.stderr.write(`server status: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return status.state === 'up' ? 0 : 1;
  }
  process.stdout.write(
    [
      `state=${status.state}`,
      `endpoint=${status.endpoint}`,
      `pid=${status.pid ?? 'none'}`,
      `http=${status.health.httpCode ?? 'unreachable'}`,
      '',
    ].join('\n'),
  );
  return status.state === 'up' ? 0 : 1;
}

async function runLogs(args: string[]): Promise<number> {
  let lines = 50;
  let follow = false;
  for (const arg of args) {
    if (arg === '--follow' || arg === '-f') follow = true;
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (arg.startsWith('--lines=')) {
      const n = Number.parseInt(arg.slice('--lines='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        process.stderr.write(`server logs: invalid --lines: ${arg}\n`);
        return 1;
      }
      lines = n;
    } else if (arg.startsWith('--')) {
      process.stderr.write(`Unknown flag: ${arg}\n`);
      return 1;
    }
  }

  const onLine = (e: serverLogsMod.LogLineEvent): void => {
    process.stdout.write(`${e.line}\n`);
  };

  if (isLocalDispatch()) {
    const ac = new AbortController();
    const abort = (): void => ac.abort();
    process.once('SIGINT', abort);
    process.once('SIGTERM', abort);
    try {
      await serverLogsMod.tailServerLog({
        lines,
        follow,
        signal: ac.signal,
        onLine,
      });
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
    return 0;
  }

  // Remote path. serverLogs has no terminal `done` event; a normal
  // completion means the subscription closed cleanly (backfill drained
  // in non-follow mode, or user-initiated abort in follow mode).
  await new Promise<void>((resolve, reject) => {
    const sub = getNodeClient().serverLogs.subscribe(
      { lines, follow },
      {
        onData: (e: unknown) => {
          const evt = e as serverLogsMod.LogLineEvent;
          if (evt.type === 'line') onLine(evt);
        },
        onError: (err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        },
        onComplete: () => {
          cleanup();
          resolve();
        },
      },
    );
    const abort = (): void => {
      sub.unsubscribe();
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
  }).catch((err: Error) => {
    process.stderr.write(`server logs: remote call to '${getGlobals().nodeName ?? ''}' failed: ${err.message}\n`);
    return 1;
  });
  return 0;
}

export async function runServer(args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'start':
      return runStart(rest);
    case 'stop':
      return runStop(rest);
    case 'status':
      return runStatus(rest);
    case 'logs':
      return runLogs(rest);
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      process.stdout.write(USAGE);
      return sub ? 0 : 1;
    default:
      process.stderr.write(`Unknown server subcommand: ${sub}\n\n${USAGE}`);
      return 1;
  }
}
