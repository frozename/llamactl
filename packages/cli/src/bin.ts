#!/usr/bin/env bun
import { runEnv } from './commands/env.js';

const USAGE = `llamactl — local-first toolkit for running llama.cpp

Usage:
  llamactl env --eval        Emit POSIX export lines for a shell to eval
  llamactl env --json        Emit the resolved environment as JSON
  llamactl env               Shorthand for --eval

More commands will land as the TypeScript core library absorbs the
historical zsh surface. See https://github.com/frozename/llamactl.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'env':
      return runEnv(rest);
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

const code = await main(process.argv.slice(2));
process.exit(code);
