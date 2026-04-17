import { env } from '@llamactl/core';

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

  const resolved = env.resolveEnv();
  if (parsed.mode === 'json') {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(env.formatEvalScript(resolved));
  return 0;
}
