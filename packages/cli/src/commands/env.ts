import { env } from '@llamactl/core';
import { getGlobals, getNodeClient, isLocalDispatch } from '../dispatcher.js';

interface ParsedFlags {
  mode: 'eval' | 'json';
}

function parse(args: string[]): ParsedFlags | { error: string } {
  let mode: ParsedFlags['mode'] = 'eval';
  for (const arg of args) {
    switch (arg) {
      case '--eval':
        mode = 'eval';
        break;
      case '--json':
        mode = 'json';
        break;
      default:
        return { error: `Unknown flag for env: ${arg}` };
    }
  }
  return { mode };
}

export async function runEnv(args: string[]): Promise<number> {
  const parsed = parse(args);
  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 1;
  }

  let resolved: ReturnType<typeof env.resolveEnv>;
  if (isLocalDispatch()) {
    resolved = env.resolveEnv();
  } else {
    try {
      resolved = await getNodeClient().env.query() as ReturnType<typeof env.resolveEnv>;
    } catch (err) {
      process.stderr.write(`env: remote call to '${getGlobals().nodeName ?? ''}' failed: ${(err as Error).message}\n`);
      return 1;
    }
  }
  if (parsed.mode === 'json') {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(env.formatEvalScript(resolved));
  return 0;
}
